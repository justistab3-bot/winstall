/**
 * UI 渲染校验：不靠肉眼，直接把渲染后的 DOM、布局与运行时报错抓成结构化报告。
 *
 *   node_modules\electron\dist\electron.exe scripts/ui-verify.cjs
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '.fixtures.json'), 'utf8'))

/**
 * electron.exe 在 Windows 上是 GUI 子系统程序，shell 重定向抓不到它的 stdout。
 * 所以自己把报告落到文件里，保证结果可留存。
 */
const REPORT_FILE = path.join(ROOT, 'screenshots', 'ui-report.txt')
const captured = []
const rawLog = console.log.bind(console)
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
  captured.push(line)
  rawLog(...args)
}
function flushReport() {
  try {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true })
    fs.writeFileSync(REPORT_FILE, captured.join('\n') + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

const REAL_DEVICE = {
  serial: 'BS371P800CY0151238',
  state: 'device',
  model: 'P600PRO',
  product: 'P600PRO',
  device: 'P600PRO',
  transportId: '11',
  enriched: true,
  enrichError: null,
  androidRelease: '5.1',
  sdkInt: 22,
  abi: 'armeabi-v7a',
  abiList: ['armeabi-v7a', 'armeabi'],
  abiList32: ['armeabi-v7a', 'armeabi'],
  abiList64: [],
  bitness: '32',
  manufacturer: 'PEN',
  brand: 'PEN',
  isEmulator: false,
  storageFreeBytes: 961_544_192,
  batteryLevel: null
}

const MAGISK = FIXTURES.apks.find((a) => a.packageName === 'com.topjohnwu.magisk')
const PINYIN = FIXTURES.apks.find((a) => a.packageName === 'com.keanbin.pinyinime')
const ARM64_ONLY = {
  ...MAGISK,
  filePath: 'C:\\Users\\Tab3\\Downloads\\modern-app.apk',
  fileName: 'modern-app.apk',
  packageName: 'com.example.modernapp',
  appLabel: '现代应用',
  versionName: '1.4.2',
  versionCode: 142,
  minSdk: 26,
  targetSdk: 34,
  fileSize: 48_234_112,
  nativeAbis: ['arm64-v8a'],
  hasNativeLibs: true,
  iconDataUrl: null
}

const ADB_OK = {
  available: true,
  adbPath: 'C:\\Android\\platform-tools\\adb.exe',
  source: 'sdk',
  clientVersion: '37.0.1',
  serverVersion: '37.0.1',
  serverPort: 5037,
  portConflict: false,
  versionConflict: false,
  busy: false,
  lastError: null,
  logs: [
    { id: 'a1', at: Date.now() - 5000, level: 'info', title: '已定位 adb', detail: '来源：Android SDK' },
    { id: 'a2', at: Date.now() - 4000, level: 'fixed', title: '检测到版本不一致的旧 ADB 服务，已自动重启' },
    { id: 'a3', at: Date.now() - 3000, level: 'warn', title: '端口 5037 被占用，已自动切换到 5038' }
  ]
}

const BASE_SETTINGS = {
  theme: 'light',
  adbPathOverride: '',
  replace: true,
  grantAll: true,
  allowDowngrade: false,
  allowTest: false,
  launchAfterInstall: false,
  autoCleanup: true,
  dynamicColor: true,
  batchInstall: true
}

/** 模拟「从壁纸提取到的」种子色 —— 用一个明显的绿色，方便验证动态取色真的生效 */
const COLOR_STATE = {
  enabled: true,
  seed: '#2E7D57',
  wallpaperPath: 'C:\\Users\\Tab4\\Pictures\\wallpaper.jpg',
  error: null
}

/** 模拟设备上的应用列表（数量与真实设备接近，用于检验列表性能与筛选） */
function mockApps() {
  const sys = [
    'android', 'android.ext.services', 'android.ext.shared', 'com.android.systemui',
    'com.android.settings', 'com.android.providers.media', 'com.android.bluetooth',
    'com.android.phone', 'com.android.nfc', 'com.android.shell', 'com.android.vending',
    'com.google.android.gms', 'com.google.android.gsf', 'com.android.providers.contacts',
    'com.android.providers.calendar', 'com.android.providers.downloads',
    'com.android.wallpaper', 'com.android.launcher3', 'com.android.keychain',
    'com.android.certinstaller', 'com.android.packageinstaller', 'com.android.permissioncontroller',
    'com.android.traceur', 'com.android.dynsystem', 'com.android.wallpaperbackup',
    'com.android.internal.systemui.navbar.gestural', 'com.android.emergency',
    'com.android.managedprovisioning', 'com.android.mms', 'com.android.deskclock',
    'com.android.camera2', 'com.android.gallery3d', 'com.android.documentsui'
  ].map((p, i) => ({
    packageName: p,
    apkPath: `/system/priv-app/${p.split('.').pop()}/base.apk`,
    isSystem: true,
    isDisabled: i === 5,
    versionCode: 30 + i,
    uid: 10000 + i
  }))
  const user = [
    { packageName: 'com.tencent.mm', versionCode: 2340 },
    { packageName: 'com.ss.android.ugc.aweme', versionCode: 280100 },
    { packageName: 'io.github.huskydg.magisk', versionCode: 27000 },
    { packageName: 'com.wys.appmarket', versionCode: 412 },
    { packageName: 'mark.via', versionCode: 20220618 }
  ].map((u, i) => ({
    ...u,
    apkPath: `/data/app/~~hash${i}==/${u.packageName}-abc==/base.apk`,
    isSystem: false,
    isDisabled: false,
    uid: 10100 + i
  }))
  return [...sys, ...user]
}

const state = { devices: [], adb: ADB_OK, settings: { ...BASE_SETTINGS }, apk: MAGISK, color: COLOR_STATE }

function registerIpc() {
  ipcMain.handle('device:list', () => state.devices)
  ipcMain.handle('device:refresh', () => state.devices)
  ipcMain.handle('adb:status', () => state.adb)
  ipcMain.handle('adb:repair', () => state.adb)
  ipcMain.handle('apk:pick', () => [state.apk.filePath])
  ipcMain.handle('apk:parse', () => [state.apk])
  ipcMain.handle('install:start', () => ({ taskId: 't1', ok: true, stage: 'success', durationMs: 3200 }))
  ipcMain.handle('install:cancel', () => true)
  ipcMain.handle('app:launch', () => ({ ok: true, message: '已启动' }))
  ipcMain.handle('color:state', () => state.color)
  ipcMain.handle('color:refresh', () => state.color)
  ipcMain.handle('apps:list', () => mockApps())
  ipcMain.handle('apps:resolve', (_e, p) => ({
    packageName: p.packageName,
    label: '已解析的应用名',
    iconDataUrl: null,
    error: null
  }))
  ipcMain.handle('apps:run', (_e, p) => ({ ...p, ok: true, message: '已执行' }))
  ipcMain.handle('sys:getSettings', () => state.settings)
  ipcMain.handle('sys:setSettings', (_e, p) => (state.settings = { ...state.settings, ...(p || {}) }))
  ipcMain.handle('sys:openExternal', () => true)
  ipcMain.handle('sys:revealFile', () => true)
  ipcMain.handle('win:minimize', () => true)
  ipcMain.handle('win:maximize', () => true)
  ipcMain.handle('win:close', () => true)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 抓取一份 DOM / 布局 / 配色快照 */
const PROBE = `(() => {
  const txt = (document.body.innerText || '').trim();
  const isSvgPart = (el) => el instanceof SVGElement || !!el.closest('svg');
  // 只扫描 body —— head 里的 <title>/<meta> 天然零尺寸，不是布局问题
  const all = [...document.body.querySelectorAll('*')].filter(el => !isSvgPart(el));
  /**
   * 布局溢出判定：只看**参与正常流**的子元素。
   * 不用 scrollWidth —— 它会把绝对定位的内部件（MUI Switch 滑块、Tooltip 箭头）
   * 以及动画残留的亚像素 transform 都算进来，全是误报。
   */
  const TOLERANCE = 4;
  const overflow = all
    .filter(el => {
      if (el.clientWidth === 0) return false;
      const pr = el.getBoundingClientRect();
      return [...el.children].some(k => {
        const ks = getComputedStyle(k);
        if (ks.position === 'absolute' || ks.position === 'fixed') return false;
        return k.getBoundingClientRect().right - pr.right > TOLERANCE;
      });
    })
    .slice(0, 8)
    .map(el => {
      const pr = el.getBoundingClientRect();
      const kids = [...el.children].map(k => {
        if (['absolute','fixed'].includes(getComputedStyle(k).position)) return null;
        const over = Math.round(k.getBoundingClientRect().right - pr.right);
        return over > TOLERANCE ? (k.tagName.toLowerCase() + '.' + String(k.className||'').split(' ')[0] + ' 超出 ' + over + 'px') : null;
      }).filter(Boolean).slice(0, 3);
      return (el.tagName.toLowerCase()) + '.' + String(el.className || '').split(' ')[0] + ' w=' + Math.round(pr.width) + ' ← ' + kids.join(' ; ');
    });
  const zeroEls = all.filter(el => {
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 && el.children.length === 0 && (el.textContent||'').trim().length > 0;
  }).slice(0, 5).map(el => el.tagName.toLowerCase() + '.' + String(el.className||'').split(' ').slice(0,2).join('.') + ' :: ' + (el.textContent||'').trim().slice(0, 36));
  const zero = zeroEls.length;
  const cs = getComputedStyle(document.body);
  const rects = {};
  const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const radii = all
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(x => x.r.width > 300 && x.r.height > 56)
    .slice(0, 10)
    .map(x => Math.round(x.r.width) + '×' + Math.round(x.r.height) + ' 圆角 ' + getComputedStyle(x.el).borderRadius);
  return {
    radii,
    text: txt,
    lineCount: txt.split('\\n').filter(Boolean).length,
    bodyBg: cs.backgroundColor,
    bodyColor: cs.color,
    fontFamily: cs.fontFamily.slice(0, 40),
    docHeight: document.documentElement.scrollHeight,
    viewport: [window.innerWidth, window.innerHeight],
    overflow,
    zeroSizedWithText: zero,
    zeroSizedDetail: zeroEls,
    buttons: [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean),
    imgs: [...document.querySelectorAll('img')].map(i => ({ src: i.src.slice(0, 24), w: i.naturalWidth, h: i.naturalHeight })),
    rootRect: pick('#root'),
    svgCount: document.querySelectorAll('svg').length,
    /** 主按钮背景色 —— 用来验证动态取色是否真的改变了主题 */
    primaryButtonBg: (() => {
      const el = document.querySelector('button.MuiButton-contained');
      return el ? getComputedStyle(el).backgroundColor : null;
    })(),
    bodyBg: cs.backgroundColor
  };
})()`

/**
 * 点击一个元素。
 * MUI 的 ButtonBase/ToggleButton 依赖完整的指针事件序列，
 * 单纯 el.click() 在部分组件上不会触发 React 的 onClick。
 */
async function clickByText(win, text, opts = {}) {
  return win.webContents.executeJavaScript(`
    (() => {
      const want = ${JSON.stringify(text)};
      const exact = ${opts.exact ? 'true' : 'false'};
      const els = [...document.querySelectorAll('button, [role="button"], .MuiChip-root')];
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const el = exact
        ? els.find(e => norm(e.textContent) === want)
        : els.find(e => (e.textContent || '').includes(want));
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const base = {
        bubbles: true, cancelable: true, composed: true, button: 0,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2
      };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.click();
      return true;
    })()`)
}

/** 精确统计对话框里渲染出的应用行数（组件带 data-app-row 标记） */
const COUNT_ROWS = `document.querySelectorAll('[data-app-row]').length`

/** 统计当前选中的筛选项 */
const SELECTED_FILTER = `(() => {
  const el = document.querySelector('.MuiToggleButton-root.Mui-selected');
  return el ? el.textContent.trim() : null;
})()`
/** 用真实键盘事件输入文本 —— 这样才能真正触发 React 的 onChange */
async function typeInto(win, placeholderPart, text) {
  const focused = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('input[placeholder*=${JSON.stringify(placeholderPart)}]');
      if (!input) return false;
      input.focus();
      return document.activeElement === input;
    })()`)
  if (!focused) return false
  // Ctrl+A 全选后直接输入，覆盖原内容
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] })
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  }
  return true
}

let problems = []

function report(name, probe, consoleErrors) {
  console.log(`\n${'═'.repeat(74)}\n【${name}】\n${'═'.repeat(74)}`)
  console.log(`  视口 ${probe.viewport.join('×')}  文档高 ${probe.docHeight}  body背景 ${probe.bodyBg}`)
  console.log(`  主按钮底色 ${probe.primaryButtonBg ?? '(无)'}`)
  console.log(`  文本行数 ${probe.lineCount}  按钮 [${probe.buttons.join(' | ')}]`)
  console.log(`  SVG 图标 ${probe.svgCount} 个  <img> ${probe.imgs.length} 个`)
  if (probe.radii && probe.radii.length) {
    console.log(`  主要容器圆角：`)
    for (const r of probe.radii) console.log(`    ${r}`)
  }
  for (const i of probe.imgs) console.log(`    img ${i.src}…  原始尺寸 ${i.w}×${i.h}`)
  console.log(`  内容：`)
  for (const l of probe.text.split('\n').filter(Boolean)) console.log(`    │ ${l}`)

  if (probe.overflow.length) {
    console.log(`  ⚠ 横向溢出 ${probe.overflow.length} 处：${probe.overflow.join(' , ')}`)
    problems.push(`${name}: 横向溢出`)
  }
  if (probe.zeroSizedWithText > 0) {
    console.log(`  ⚠ 有 ${probe.zeroSizedWithText} 个含文本但零尺寸的元素：`)
    for (const z of probe.zeroSizedDetail) console.log(`      ${z}`)
    problems.push(`${name}: 零尺寸元素`)
  }
  if (probe.docHeight > probe.viewport[1] + 4) {
    console.log(`  ℹ 内容超出一屏（可滚动），文档高 ${probe.docHeight} > 视口 ${probe.viewport[1]}`)
  }
  if (probe.imgs.some((i) => i.w === 0)) {
    console.log(`  ⚠ 有图片未能解码（naturalWidth=0）`)
    problems.push(`${name}: 图标解码失败`)
  }
  if (consoleErrors.length) {
    console.log(`  ✗ 控制台报错 ${consoleErrors.length} 条：`)
    for (const e of consoleErrors.slice(0, 10)) console.log(`      ${e}`)
    problems.push(`${name}: 控制台报错`)
  }
  if (probe.text.length < 20) {
    console.log(`  ✗ 页面几乎是空白`)
    problems.push(`${name}: 空白页`)
  }
}

async function main() {
  registerIpc()

  const win = new BrowserWindow({
    width: 1060,
    height: 760,
    show: false, // 不弹窗，避免干扰用户
    paintWhenInitiallyHidden: true,
    backgroundColor: '#FEF7FF',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#FEF7FF', symbolColor: '#1d1b20', height: 48 },
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  let consoleErrors = []
  win.webContents.on('console-message', (...args) => {
    // Electron 44: 单参数事件对象；旧版: (event, level, message, line, sourceId)
    const e = args[0]
    const level = typeof e === 'object' && e && 'level' in e ? e.level : args[1]
    const message = typeof e === 'object' && e && 'message' in e ? e.message : args[2]
    const isError = level === 'error' || level === 3 || level === 'warning'
    if (isError) consoleErrors.push(`[${level}] ${String(message).slice(0, 220)}`)
  })

  const indexHtml = path.join(ROOT, 'out', 'renderer', 'index.html')
  const load = async () => {
    consoleErrors = []
    await win.loadFile(indexHtml)
    await wait(1300)
  }

  /* 1. 空状态 */
  state.devices = []
  state.settings = { ...BASE_SETTINGS }
  state.apk = MAGISK
  await load()
  report('1. 未连接设备（浅色）', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 2. 设备已连接 */
  state.devices = [REAL_DEVICE]
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(700)
  report('2. 设备已连接 · Android 5.1 / 32 位', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 3. 载入 32 位兼容包 */
  await clickByText(win, '选择安装包')
  await wait(900)
  report('3. 载入兼容包（Magisk，含 armeabi-v7a）', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 4. 纯 64 位包 → 架构不匹配 */
  state.apk = ARM64_ONLY
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(500)
  await clickByText(win, '选择安装包')
  await wait(900)
  report('4. 纯 64 位包 → 架构不匹配提示', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 5. 中文名 + 真实图标 */
  state.apk = PINYIN
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(500)
  await clickByText(win, '选择安装包')
  await wait(900)
  report('5. 中文应用名与真实图标', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 6. 安装进度 */
  win.webContents.send('install:progress', {
    taskId: 't1',
    stage: 'pushing',
    percent: 43,
    indeterminate: false,
    message: '正在推送安装包到设备…',
    bytesSent: 20_740_668,
    bytesTotal: 48_234_112
  })
  await wait(700)
  report('6. 安装进行中（推送 43%）', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 7. 深色主题 */
  state.devices = [REAL_DEVICE]
  state.settings = { ...BASE_SETTINGS, theme: 'dark' }
  nativeTheme.themeSource = 'dark'
  state.apk = MAGISK
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(500)
  await clickByText(win, '选择安装包')
  await wait(900)
  report('7. 深色主题 + 安装包', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 8. ADB 日志抽屉 */
  await clickByText(win, 'ADB 就绪')
  await wait(800)
  report('8. ADB 诊断抽屉', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 9. 设置对话框 */
  await clickByText(win, 'ADB 就绪')
  await wait(400)
  const opened = await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => (x.getAttribute('aria-label')||'') === '设置' || (x.closest('[aria-label="设置"]')));
      if (b) { b.click(); return true }
      return false;
    })()`)
  await wait(900)
  report(`9. 设置对话框（点击成功=${opened}）`, await win.webContents.executeJavaScript(PROBE), consoleErrors)

  /* 10. 动态取色：种子色换成绿色后，主色应真的变化 */
  state.devices = [REAL_DEVICE]
  state.settings = { ...BASE_SETTINGS, theme: 'light' }
  state.apk = MAGISK
  state.color = { enabled: true, seed: '#2E7D57', wallpaperPath: 'C:\\wall.jpg', error: null }
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await wait(900)
  const greenProbe = await win.webContents.executeJavaScript(PROBE)
  report('10. 动态取色 · 绿色种子 (#2E7D57)', greenProbe, consoleErrors)

  // 断言：主按钮底色应该偏向绿色（G 通道最大），而不是默认紫
  const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(greenProbe.primaryButtonBg || '')
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    const isGreenish = g >= r && g >= b
    console.log(`  动态取色断言：rgb(${r},${g},${b}) ${isGreenish ? '偏绿 ✓' : '不偏绿 ✗'}`)
    if (!isGreenish) problems.push('10: 动态取色未生效')
  } else {
    console.log('  ⚠ 未能取到主按钮底色，跳过动态取色断言')
    problems.push('10: 无法验证动态取色')
  }

  /* 11. 默认紫色对照 */
  state.color = { enabled: false, seed: null, wallpaperPath: null, error: null }
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await wait(900)
  const purpleProbe = await win.webContents.executeJavaScript(PROBE)
  console.log(`\n  【对照】关闭动态取色 → 主按钮底色 ${purpleProbe.primaryButtonBg}`)
  if (purpleProbe.primaryButtonBg === greenProbe.primaryButtonBg) {
    problems.push('11: 开关动态取色后主色没有变化')
    console.log('  ✗ 与绿色种子下的主色相同，动态取色未真正生效')
  } else {
    console.log('  ✓ 与绿色种子下的主色不同，动态取色确实在起作用')
  }

  /* 12. 安装成功后按钮应变成「打开应用」 */
  state.color = COLOR_STATE
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await wait(700)
  const beforeInstall = await win.webContents.executeJavaScript(PROBE)
  console.log(`\n  安装前按钮：[${beforeInstall.buttons.join(' | ')}]`)
  await clickByText(win, '开始安装')
  await wait(2600)
  const afterInstall = await win.webContents.executeJavaScript(PROBE)
  report('12. 安装成功后的按钮状态', afterInstall, consoleErrors)
  const hasOpen = afterInstall.buttons.some((b) => b.includes('打开应用'))
  const hasReinstall = afterInstall.buttons.some((b) => b.includes('重新安装'))
  console.log(`  断言：出现「打开应用」=${hasOpen}  出现「重新安装」=${hasReinstall}`)
  if (!hasOpen || !hasReinstall) problems.push('12: 安装成功后按钮未切换为「打开应用」')

  /* 13. 应用管理对话框 */
  await clickByText(win, '管理应用')
  await wait(1400)
  report('13. 管理应用对话框', await win.webContents.executeJavaScript(PROBE), consoleErrors)

  // 切换筛选到「用户」，验证列表真的被过滤
  const rowsAll = await win.webContents.executeJavaScript(COUNT_ROWS)
  const filtered = await clickByText(win, '用户 5', { exact: true })
  await wait(900)
  const userProbe = await win.webContents.executeJavaScript(PROBE)
  const rowsUser = await win.webContents.executeJavaScript(COUNT_ROWS)
  const selected = await win.webContents.executeJavaScript(SELECTED_FILTER)
  console.log(`\n  点击「用户」筛选 生效=${filtered}  当前选中=${selected}`)
  console.log(`  行数变化：全部 ${rowsAll} → 用户 ${rowsUser}`)
  report('14. 管理应用 · 用户应用筛选', userProbe, consoleErrors)
  if (rowsUser >= rowsAll || rowsUser > 12) {
    problems.push(`14: 用户应用筛选未生效（${rowsAll} → ${rowsUser}）`)
  }

  // 搜索过滤：用真实键盘输入
  let typed = false
  try {
    typed = await typeInto(win, '搜索', 'magisk')
  } catch (e) {
    console.log(`  输入失败：${e.message}`)
  }
  await wait(900)
  const searchProbe = await win.webContents.executeJavaScript(PROBE)
  const rowsSearch = await win.webContents.executeJavaScript(COUNT_ROWS)
  console.log(`\n  搜索 "magisk" 输入生效=${typed}  行数 ${rowsUser} → ${rowsSearch}`)
  report('15. 管理应用 · 搜索过滤', searchProbe, consoleErrors)
  if (!searchProbe.text.includes('magisk')) problems.push('15: 搜索未过滤出结果')
  if (rowsSearch > 3) problems.push(`15: 搜索未生效（仍有 ${rowsSearch} 行）`)

  console.log(`\n${'═'.repeat(74)}`)
  if (problems.length === 0) console.log('结论：未发现渲染问题 ✓')
  else {
    console.log(`结论：发现 ${problems.length} 个问题 ✗`)
    for (const p of problems) console.log(`  · ${p}`)
  }
  console.log('═'.repeat(74))

  flushReport()
  app.exit(problems.length ? 2 : 0)
}

app.whenReady().then(() => {
  const watchdog = setTimeout(() => {
    console.error('看门狗超时，强制退出')
    app.exit(3)
  }, 90_000)

  main()
    .then(() => clearTimeout(watchdog))
    .catch((e) => {
      clearTimeout(watchdog)
      console.error('校验失败：', e)
      flushReport()
      app.exit(1)
    })
})
