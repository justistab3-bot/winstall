/**
 * 生成应用图标：用 Electron 渲染矢量图，再手写 ICO 容器。
 *
 *   npm run icon
 *
 * 设计：深紫渐变圆角方块 + 「箭头落入托盘」。
 * 托盘代表「设备 / 容器」，箭头代表「装入」，合起来就是安装这个动作本身 ——
 * 比放一个 Android 吉祥物更贴切，也不会牵扯第三方商标。
 *
 * 产出 build/icon.png（256）与 build/icon.ico（7 个尺寸）。
 * 因为无法用肉眼确认渲染结果，脚本会做程序化校验（见 verify*）。
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 前景构图（256×256 画布内的坐标）：
 *   箭杆   x 117..139, y  35..95（圆角矩形）
 *   箭头   底边 y=81、跨度 x 92..164，顶点 (128,135)，描边圆角
 *   托盘   开口朝上的 U 形，y 169..211，x 64..192，描边圆角
 *
 * 垂直包围盒 35..221.5，水平 53.5..202.5，在 6..250 的圆角方块内居中。
 * 箭头尖端（约 y=141.5）与托盘顶部（约 y=158.5）留出 17px 间隙 ——
 * 这个间隙是刻意的：太小会糊在一起，太大又会散架。
 */
function svg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0.05" y1="0" x2="0.95" y2="1">
      <stop offset="0" stop-color="#9279DE"/>
      <stop offset="0.42" stop-color="#6750A4"/>
      <stop offset="1" stop-color="#3F2C6E"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.26" cy="0.14" r="0.9">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#EDE4FF"/>
    </linearGradient>
  </defs>

  <!-- 底板 -->
  <rect x="6" y="6" width="244" height="244" rx="60" fill="url(#bg)"/>
  <rect x="6" y="6" width="244" height="244" rx="60" fill="url(#glow)"/>
  <!-- 极细内描边：在浅色背景上也能看清边界 -->
  <rect x="6.8" y="6.8" width="242.4" height="242.4" rx="59.2"
        fill="none" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1.6"/>

  <!-- 箭头 -->
  <g fill="url(#fg)">
    <rect x="117" y="35" width="22" height="60" rx="11"/>
    <path d="M128 135 L92 81 H164 Z" stroke="url(#fg)" stroke-width="13" stroke-linejoin="round"/>
  </g>

  <!-- 托盘（开口朝上，承接箭头） -->
  <path d="M64 169 V183 A28 28 0 0 0 92 211 H164 A28 28 0 0 0 192 183 V169"
        fill="none" stroke="url(#fg)" stroke-opacity="0.9"
        stroke-width="21" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
}

/** 把若干 PNG 打包成 ICO（Vista+ 支持 PNG 压缩条目） */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const p = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 0) // 0 表示 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1)
    dir.writeUInt8(0, p + 2) // 调色板数
    dir.writeUInt8(0, p + 3) // reserved
    dir.writeUInt16LE(1, p + 4) // color planes
    dir.writeUInt16LE(32, p + 6) // bits per pixel
    dir.writeUInt32LE(e.png.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += e.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/* ------------------------------------------------------------------ */
/* 程序化校验                                                          */
/* ------------------------------------------------------------------ */

/**
 * 判断某个像素是否属于「前景」（白色图形），而非紫色底板或透明区。
 *
 * 不能只看亮度：左上角的光晕会把底色提亮到亮度 ~179，超过任何合理阈值。
 * 前景是**近中性白**，底色是**饱和紫**（蓝通道远高于绿），
 * 所以用「亮度 + 通道离散度」两个条件一起判定。
 */
function isInk(bgra, width, x, y) {
  const i = (y * width + x) * 4
  const b = bgra[i]
  const g = bgra[i + 1]
  const r = bgra[i + 2]
  const a = bgra[i + 3]
  if (a < 128) return false // 透明（圆角外侧）
  const lum = 0.114 * b + 0.587 * g + 0.299 * r
  if (lum <= 165) return false
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  return spread < 45
}

/**
 * 校验 1：中心列上，箭头与托盘必须是**两段分离**的前景。
 * 这是这个图标能不能在小尺寸下被读懂的关键 —— 一旦糊成一段，
 * 就退化成了一根竖条，完全失去「装入」的语义。
 */
function centerColumnRuns(image, size) {
  const bmp = image.toBitmap()
  const x = Math.floor(size / 2)
  let runs = 0
  let prev = false
  for (let y = 0; y < size; y++) {
    const ink = isInk(bmp, size, x, y)
    if (ink && !prev) runs++
    prev = ink
  }
  return runs
}

/** 校验 2：前景包围盒与四边留白，检查构图是否居中、有没有贴边 */
function foregroundBox(image, size) {
  const bmp = image.toBitmap()
  let minX = size
  let maxX = -1
  let minY = size
  let maxY = -1
  let ink = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isInk(bmp, size, x, y)) continue
      ink++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return {
    left: minX,
    right: size - 1 - maxX,
    top: minY,
    bottom: size - 1 - maxY,
    coverage: ink / (size * size)
  }
}

/**
 * 把渲染结果转成字符画打印出来。
 * 我看不到图片，只能靠这个确认图形到底长什么样：
 *   ' ' 透明（圆角外侧）   '.' 紫色底板   '#' 白色前景
 */
function asciiPreview(image, size) {
  const bmp = image.toBitmap()
  const lines = []
  for (let y = 0; y < size; y++) {
    let row = ''
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const a = bmp[i + 3]
      if (a < 128) {
        row += ' '
      } else {
        row += isInk(bmp, size, x, y) ? '#' : '.'
      }
    }
    lines.push(row)
  }
  return lines
}

/**
 * 校验 3：箭杆与箭头的宽度比。
 * 如果箭头不比箭杆宽，那画出来的就是一根竖条而不是箭头。
 */
function rowInkWidth(bgra, size, y) {
  let count = 0
  let first = -1
  let last = -1
  for (let x = 0; x < size; x++) {
    if (isInk(bgra, size, x, y)) {
      count++
      if (first < 0) first = x
      last = x
    }
  }
  return { count, span: last < 0 ? 0 : last - first + 1 }
}

/* ------------------------------------------------------------------ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function renderMaster() {
  const htmlPath = path.join(BUILD, '.icon-source.html')
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;overflow:hidden}
      svg{display:block}
    </style></head><body>${svg(256)}</body></html>`,
    'utf8'
  )

  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })

  await win.loadFile(htmlPath)
  await wait(520)
  const image = await win.webContents.capturePage()
  win.destroy()
  fs.rmSync(htmlPath, { force: true })
  return image
}

async function main() {
  fs.mkdirSync(BUILD, { recursive: true })

  const master = await renderMaster()
  const mSize = master.getSize()
  console.log(`  主图渲染尺寸 ${mSize.width}×${mSize.height}（受系统缩放影响）\n`)

  const entries = []
  let alphaOk = true
  let runsOk = true
  const runReport = []

  for (const size of SIZES) {
    const img = size === mSize.width ? master : master.resize({ width: size, height: size, quality: 'best' })
    const png = img.toPNG()
    const bmp = img.toBitmap()

    // 圆角外侧必须透明。小尺寸降采样会残留 1~2 级抗锯齿值，阈值放宽到 8
    const cornerAlpha = bmp.length >= 4 ? bmp[3] : -1
    if (cornerAlpha >= 8) alphaOk = false

    const runs = centerColumnRuns(img, size)
    runReport.push(`${size}px:${runs}段`)
    // 16px 下抗锯齿可能把托盘糊掉，24px 及以上必须清晰分成两段
    if (size >= 24 && runs < 2) runsOk = false

    entries.push({ size, png })
    console.log(
      `  ${String(size).padStart(3)}×${String(size).padEnd(3)} ${String(png.length).padStart(6)} B` +
        `  中心列前景 ${runs} 段  左上角 alpha=${cornerAlpha}`
    )
  }

  // 构图检查（在 256 上做，避免小尺寸量化误差）
  const img256 = master.resize({ width: 256, height: 256, quality: 'best' })
  const box256 = foregroundBox(img256, 256)
  console.log('')
  if (box256) {
    const hSym = Math.abs(box256.left - box256.right)
    console.log(
      `  构图：留白 左${box256.left} 右${box256.right} 上${box256.top} 下${box256.bottom}` +
        `  墨水覆盖 ${(box256.coverage * 100).toFixed(1)}%`
    )
    if (hSym > 3) {
      console.log(`  ⚠ 左右留白不对称（相差 ${hSym}px）`)
    } else {
      console.log(`  ✓ 左右留白对称（相差 ${hSym}px）`)
    }
    if (box256.coverage < 0.08 || box256.coverage > 0.34) {
      console.log(`  ⚠ 墨水覆盖 ${(box256.coverage * 100).toFixed(1)}% 偏离常见区间 8%~34%`)
    } else {
      console.log(`  ✓ 墨水覆盖在常见区间内`)
    }
    if (Math.min(box256.left, box256.right, box256.top, box256.bottom) < 12) {
      console.log('  ⚠ 前景过于贴近边缘，小尺寸下可能被裁切')
    } else {
      console.log('  ✓ 四边留白充足')
    }
  }

  // 箭头形状检查：箭杆细、箭头宽、托盘两壁分离
  const bmp256 = img256.toBitmap()
  const stem = rowInkWidth(bmp256, 256, 60)
  const head = rowInkWidth(bmp256, 256, 88)
  const trayWall = rowInkWidth(bmp256, 256, 176)
  let headWider = false
  if (head.span > stem.span * 1.8) {
    headWider = true
    console.log(`  ✓ 箭头比箭杆明显更宽（杆 ${stem.span}px → 头 ${head.span}px），能读出「箭头」`)
  } else {
    console.log(`  ⚠ 箭头宽度 ${head.span}px 与箭杆 ${stem.span}px 差距不足，可能被看成一根竖条`)
  }
  console.log(`  托盘行：命中 ${trayWall.count}px，跨度 ${trayWall.span}px（两壁，中间应为空）`)

  // 箭头尖端与托盘之间的间隙：太小学生尺寸下会糊成一块
  let gapStart = -1
  let gapEnd = -1
  const cx = 128
  for (let y = 120; y < 175; y++) {
    if (!isInk(bmp256, 256, cx, y)) {
      if (gapStart < 0) gapStart = y
      gapEnd = y
    } else if (gapStart >= 0 && gapEnd > gapStart) {
      break
    }
  }
  const gap = gapEnd - gapStart + 1
  if (gap >= 8 && gap <= 40) {
    console.log(`  ✓ 箭头尖端与托盘间隙 ${gap}px，处于 8~40px 的合理区间`)
  } else {
    console.log(`  ⚠ 箭头尖端与托盘间隙 ${gap}px，偏离 8~40px 的合理区间`)
  }

  // 字符画预览 —— 用来肉眼（在终端里）确认图形
  console.log('\n  字符画预览（# 前景 · 底板 · 透明）：')
  const art = asciiPreview(master.resize({ width: 56, height: 56, quality: 'best' }), 56)
  for (const line of art) console.log(`    ${line}`)

  const ico = buildIco(entries)
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico)
  const png256 = entries.find((e) => e.size === 256).png
  fs.writeFileSync(path.join(BUILD, 'icon.png'), png256)

  console.log(`\n  build/icon.ico  ${ico.length} B  (${SIZES.length} 个尺寸)`)
  console.log(`  build/icon.png  ${png256.length} B  (256×256)`)
  console.log(`  中心列分段：${runReport.join('  ')}`)
  console.log(`  透明通道: ${alphaOk ? '正常 ✓' : '异常 ✗（四角不透明）'}`)
  console.log(`  小尺寸可读性: ${runsOk ? '正常 ✓（箭头与托盘保持分离）' : '异常 ✗（已糊成一段）'}`)

  app.exit(alphaOk && runsOk ? 0 : 2)
}

app.whenReady().then(() => {
  const watchdog = setTimeout(() => {
    console.error('看门狗超时')
    app.exit(3)
  }, 60_000)
  main()
    .then(() => clearTimeout(watchdog))
    .catch((e) => {
      clearTimeout(watchdog)
      console.error('生成图标失败：', e)
      app.exit(1)
    })
})
