/**
 * UI 截图夹具：用真实的 preload 与构建产物驱动渲染层，抓取各状态截图。
 *
 *   npx electron scripts/screenshot.cjs
 *
 * 产物写入 screenshots/ 目录。
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'screenshots')
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '.fixtures.json'), 'utf8'))

/* ------------------------------ 模拟数据 ------------------------------ */

/** 与真实设备 P600PRO 完全一致的画像（Android 5.1 / 纯 32 位） */
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
const LAUNCHER = FIXTURES.apks.find((a) => a.packageName === 'com.pen.launcher')

/** 纯 64 位包 —— 用于验证「32 位设备装不了」的提示 */
const ARM64_ONLY = {
  ...MAGISK,
  filePath: 'C:\\Users\\Tab3\\Downloads\\some-modern-app-1.4.2.apk',
  fileName: 'some-modern-app-1.4.2.apk',
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
  adbPath: 'C:\\Users\\Tab3\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
  source: 'sdk',
  clientVersion: '37.0.1-15733141',
  serverVersion: '37.0.1-15733141',
  serverPort: 5037,
  portConflict: false,
  versionConflict: false,
  busy: false,
  lastError: null,
  logs: [
    {
      id: 'adb-1',
      at: Date.now() - 90_000,
      level: 'info',
      title: '已定位 adb：C:\\Users\\Tab3\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      detail: '来源：Android SDK'
    },
    {
      id: 'adb-2',
      at: Date.now() - 61_000,
      level: 'fixed',
      title: '检测到版本不一致的旧 ADB 服务，已自动重启',
      detail: '当前 adb 37.0.1-15733141'
    },
    {
      id: 'adb-3',
      at: Date.now() - 60_000,
      level: 'warn',
      title: '端口 5037 被「360MobileMgr.exe」占用，已自动切换到 5038',
      detail: '占用进程 PID 8824。切换到独立端口后不受该程序影响。'
    },
    {
      id: 'adb-4',
      at: Date.now() - 12_000,
      level: 'info',
      title: '设备已连接：P600PRO',
      detail: 'Android 5.1 (API 22) · 32 位 · armeabi-v7a'
    }
  ]
}

const DEFAULT_SETTINGS = {
  theme: 'system',
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

const COLOR_STATE = {
  enabled: true,
  seed: '#2E7D57',
  wallpaperPath: 'C:\\Users\\Tab4\\Pictures\\wallpaper.jpg',
  error: null
}

function mockApps() {
  const sys = [
    'android', 'android.ext.services', 'com.android.systemui', 'com.android.settings',
    'com.android.providers.media', 'com.android.bluetooth', 'com.android.phone',
    'com.android.nfc', 'com.android.shell', 'com.android.vending', 'com.google.android.gms',
    'com.android.providers.contacts', 'com.android.providers.calendar', 'com.android.wallpaper',
    'com.android.launcher3', 'com.android.certinstaller', 'com.android.packageinstaller',
    'com.android.permissioncontroller', 'com.android.traceur', 'com.android.emergency',
    'com.android.managedprovisioning', 'com.android.mms', 'com.android.deskclock',
    'com.android.camera2', 'com.android.gallery3d', 'com.android.documentsui'
  ].map((p, i) => ({
    packageName: p,
    apkPath: `/system/priv-app/${p.split('.').pop()}/base.apk`,
    isSystem: true,
    isDisabled: i === 6,
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

/* ------------------------------ 可切换状态 ------------------------------ */

const state = {
  devices: [],
  adb: ADB_OK,
  settings: { ...DEFAULT_SETTINGS },
  apkToReturn: MAGISK,
  color: COLOR_STATE
}

function registerIpc() {
  ipcMain.handle('device:list', () => state.devices)
  ipcMain.handle('device:refresh', () => state.devices)
  ipcMain.handle('adb:status', () => state.adb)
  ipcMain.handle('adb:repair', () => state.adb)
  ipcMain.handle('apk:pick', () => [state.apkToReturn.filePath])
  ipcMain.handle('apk:parse', () => [state.apkToReturn])
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
  ipcMain.handle('sys:setSettings', (_e, patch) => {
    state.settings = { ...state.settings, ...(patch || {}) }
    return state.settings
  })
  ipcMain.handle('sys:openExternal', () => true)
  ipcMain.handle('sys:revealFile', () => true)
  ipcMain.handle('win:minimize', () => true)
  ipcMain.handle('win:maximize', () => true)
  ipcMain.handle('win:close', () => true)
}

/* ------------------------------ 工具 ------------------------------ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickByText(win, text) {
  return win.webContents.executeJavaScript(`
    (() => {
      const els = [...document.querySelectorAll('button, [role="button"]')];
      const el = els.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
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
    })()
  `)
}

async function capture(win, name) {
  await wait(700) // 等动画收敛
  const image = await win.webContents.capturePage()
  const file = path.join(OUT_DIR, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  // 同时打印界面上的按钮与文本行数，便于确认截图内容确实处于预期状态
  const info = await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean);
      const txt = (document.body.innerText || '').split('\\n').filter(Boolean);
      return { btns, lines: txt.length, rows: document.querySelectorAll('[data-app-row]').length };
    })()`)
  console.log(`  ✓ ${name}.png  [${info.btns.join(' | ')}]  文本 ${info.lines} 行${info.rows ? ` · 应用行 ${info.rows}` : ''}`)
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  registerIpc()

  const win = new BrowserWindow({
    width: 1060,
    height: 760,
    // 不弹真窗口：paintWhenInitiallyHidden 默认为 true，
    // 隐藏状态下依然可以正常渲染与 capturePage
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#FEF7FF',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#FEF7FF', symbolColor: '#1d1b20', height: 48 },
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const indexHtml = path.join(ROOT, 'out', 'renderer', 'index.html')

  const load = async () => {
    await win.loadFile(indexHtml)
    await wait(1200)
  }

  /* 1. 未连接设备 */
  state.devices = []
  state.settings = { ...DEFAULT_SETTINGS, theme: 'light' }
  state.apkToReturn = MAGISK
  await load()
  await capture(win, '01-empty-light')

  /* 2. 设备已连接（Android 5.1 / 32 位） */
  state.devices = [REAL_DEVICE]
  await win.webContents.executeJavaScript('void 0')
  win.webContents.send('device:changed', [REAL_DEVICE])
  await capture(win, '02-device-connected')

  /* 3. 载入 32 位兼容包（Magisk，含 armeabi-v7a） */
  await clickByText(win, '选择安装包')
  await capture(win, '03-apk-compatible')

  /* 4. 纯 64 位包 → 架构不匹配告警 */
  state.apkToReturn = ARM64_ONLY
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await capture(win, '04-apk-abi-mismatch')

  /* 5. 中文应用名 + 真实图标（拼音输入法） */
  state.apkToReturn = PINYIN
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await capture(win, '05-apk-chinese-icon')

  /* 6. 安装中 */
  win.webContents.send('install:progress', {
    taskId: 't1',
    stage: 'pushing',
    percent: 43,
    indeterminate: false,
    message: '正在推送安装包到设备…',
    bytesSent: 20_740_668,
    bytesTotal: 48_234_112
  })
  await capture(win, '06-installing')

  /* 7. 深色主题 + 无设备 */
  state.devices = []
  state.settings = { ...DEFAULT_SETTINGS, theme: 'dark' }
  state.apkToReturn = MAGISK
  nativeTheme.themeSource = 'dark'
  await load()
  await capture(win, '07-empty-dark')

  /* 8. 深色 + 设备 + 安装包 */
  state.devices = [REAL_DEVICE]
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(300)
  await clickByText(win, '选择安装包')
  await capture(win, '08-dark-apk')

  /* 9. ADB 诊断抽屉 */
  await clickByText(win, 'ADB 就绪')
  await capture(win, '09-adb-logs')

  /* 10. 安装成功 → 按钮变成「打开应用」 */
  await clickByText(win, 'ADB 就绪')
  await wait(400)
  state.color = COLOR_STATE
  state.settings = { ...DEFAULT_SETTINGS, theme: 'light' }
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await wait(700)
  await clickByText(win, '开始安装')
  await wait(2400)
  await capture(win, '10-installed-open-app')

  /* 11. 管理应用 */
  await clickByText(win, '管理应用')
  await wait(1300)
  await capture(win, '11-app-manager')

  /* 12. 管理应用 · 用户应用筛选 */
  await clickByText(win, '用户 ')
  await wait(800)
  await capture(win, '12-app-manager-user')

  /* 13. 深色 + 动态取色 */
  state.settings = { ...DEFAULT_SETTINGS, theme: 'dark' }
  nativeTheme.themeSource = 'dark'
  await load()
  win.webContents.send('device:changed', [REAL_DEVICE])
  await wait(400)
  await clickByText(win, '选择安装包')
  await wait(800)
  await capture(win, '13-dark-dynamic-color')

  console.log('\n截图已输出到 screenshots/')
  app.quit()
}

app.whenReady().then(() => {
  // 看门狗：无论中途出什么问题都强制退出，绝不留孤儿进程
  const watchdog = setTimeout(() => {
    console.error('看门狗超时，强制退出')
    app.exit(3)
  }, 90_000)

  main()
    .then(() => clearTimeout(watchdog))
    .catch((err) => {
      clearTimeout(watchdog)
      console.error('截图失败：', err)
      app.exit(1)
    })
})
