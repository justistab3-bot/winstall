/**
 * MD3 动态取色模块验证脚本。
 *
 *   cd D:\worker\apk-installer && npx tsx scripts/md3-test.ts
 *
 * 覆盖：M3 基线对照 / HCT 往返一致性 / 色域映射 / 亮度单调性 /
 *       WCAG 对比度 / 壁纸取色 / 健壮性 / 完整色板打印。
 */
import { Buffer } from 'node:buffer'
import {
  buildPalette,
  hexToRgb,
  hctToRgb,
  hueDistance,
  normalizeHex,
  pickSeedFromBitmap,
  rgbToHex,
  rgbToHct
} from '../src/shared/md3'

/* ------------------------------------------------------------------ *
 * 断言脚手架
 * ------------------------------------------------------------------ */

let checks = 0
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)
}

function hex(rgb: { r: number; g: number; b: number }): string {
  return rgbToHex(rgb)
}

function channelDelta(a: string, b: string): number[] {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return [x.r - y.r, x.g - y.g, x.b - y.b]
}

/** WCAG 2.x 相对亮度（0-1） */
function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b)
}

/** WCAG 对比度 */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a))
  const lb = relativeLuminance(hexToRgb(b))
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function swatch(color: string): string {
  const { r, g, b } = hexToRgb(color)
  return `\x1b[48;2;${r};${g};${b}m      \x1b[0m`
}

function f(n: number, digits = 2): string {
  return n.toFixed(digits)
}

/* ------------------------------------------------------------------ *
 * 合成 BGRA 图
 * ------------------------------------------------------------------ */

type Painter = (x: number, y: number) => [number, number, number, number]

function makeBgra(width: number, height: number, painter: Painter): Buffer {
  const buf = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y)
      const i = (y * width + x) * 4
      buf[i] = b
      buf[i + 1] = g
      buf[i + 2] = r
      buf[i + 3] = a
    }
  }
  return buf
}

/** 确定性 LCG，保证随机用例可复现 */
let rngState = 0x2f6e2b1
function rnd(): number {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0
  return rngState / 4294967296
}

/* ================================================================== *
 * 1. M3 基线对照
 * ================================================================== */

section('1. M3 基线对照（最关键回归断言）')

const BASELINES = ['#6750A4', '#006A6A']

for (const baseline of BASELINES) {
  const palette = buildPalette(baseline)
  const seedHct = rgbToHct(hexToRgb(baseline))
  const delta = channelDelta(palette.light.primary, baseline)
  const maxDelta = Math.max(...delta.map((d) => Math.abs(d)))
  console.log(
    `  seed ${baseline}  HCT(h=${f(seedHct.h)}, c=${f(seedHct.c)}, t=${f(seedHct.t)})` +
      `  校正后 seed=${palette.seed}`
  )
  console.log(
    `  light.primary = ${palette.light.primary} ${swatch(palette.light.primary)}` +
      `   ΔRGB = [${delta.join(', ')}]`
  )
  check(
    `buildPalette('${baseline}').light.primary ≈ ${baseline}（每通道 ±12）`,
    maxDelta <= 12,
    `max|Δ| = ${maxDelta}`
  )
  check(
    `buildPalette('${baseline}').seed 保持为 ${baseline}`,
    palette.seed === baseline,
    `实际 ${palette.seed}`
  )
}

/* ================================================================== *
 * 2. HCT 往返一致性
 * ================================================================== */

section('2. rgbToHct -> hctToRgb 往返一致性（每通道 ±2）')

const FIXED_SAMPLES = [
  '#FF0000',
  '#00FF00',
  '#0000FF',
  '#FFFF00',
  '#00FFFF',
  '#FF00FF',
  '#FFFFFF',
  '#000000',
  '#808080',
  '#123456',
  '#FEDCBA',
  '#6750A4',
  '#006A6A',
  '#3B82F6',
  '#B3261E',
  '#E8DEF8',
  '#1D192B',
  '#FFD8E4',
  '#7D5260',
  '#4A6363'
]

const randomSamples: string[] = []
for (let i = 0; i < 400; i++) {
  randomSamples.push(
    hex({
      r: Math.floor(rnd() * 256),
      g: Math.floor(rnd() * 256),
      b: Math.floor(rnd() * 256)
    })
  )
}

let roundTripWorst = 0
let roundTripWorstColor = ''
const roundTripFailures: string[] = []

for (const sample of FIXED_SAMPLES.concat(randomSamples)) {
  const source = hexToRgb(sample)
  const hct = rgbToHct(source)
  const back = hctToRgb(hct.h, hct.c, hct.t)
  const delta = Math.max(
    Math.abs(back.r - source.r),
    Math.abs(back.g - source.g),
    Math.abs(back.b - source.b)
  )
  if (delta > roundTripWorst) {
    roundTripWorst = delta
    roundTripWorstColor = `${sample} -> ${hex(back)} (h=${f(hct.h)}, c=${f(hct.c)}, t=${f(hct.t)})`
  }
  if (delta > 2) roundTripFailures.push(`${sample} -> ${hex(back)} (Δ=${delta})`)
}

check(
  `${FIXED_SAMPLES.length + randomSamples.length} 个颜色往返误差均 ≤ 2`,
  roundTripFailures.length === 0,
  `最大 Δ=${roundTripWorst} 于 ${roundTripWorstColor}`
)
if (roundTripFailures.length > 0) {
  for (const line of roundTripFailures.slice(0, 10)) console.log(`      ${line}`)
}

/* ================================================================== *
 * 3. 色域映射
 * ================================================================== */

section('3. 色域映射（超 sRGB 的高 chroma 请求）')

const GAMUT_CASES: Array<{ h: number; c: number; t: number }> = [
  { h: 258, c: 200, t: 50 },
  { h: 0, c: 180, t: 40 },
  { h: 120, c: 160, t: 30 },
  { h: 300, c: 145, t: 70 }
]

for (const testCase of GAMUT_CASES) {
  const result = hctToRgb(testCase.h, testCase.c, testCase.t)
  const inRange =
    [result.r, result.g, result.b].every(
      (v) => Number.isInteger(v) && v >= 0 && v <= 255
    )
  const back = rgbToHct(result)
  const hueDiff = hueDistance(back.h, testCase.h)
  const toneDiff = Math.abs(back.t - testCase.t)

  console.log(
    `  HCT(${testCase.h}, ${testCase.c}, ${testCase.t}) -> ${hex(result)} ${swatch(hex(result))}` +
      `  实际 HCT(h=${f(back.h, 1)}, c=${f(back.c, 1)}, t=${f(back.t, 2)})`
  )
  check(`  RGB 在 [0,255] 且为整数`, inRange)
  check(`  色相基本保持（|ΔH| ≤ 3°）`, hueDiff <= 3, `ΔH=${f(hueDiff, 2)}°`)
  check(`  tone 基本保持（|ΔT| ≤ 1）`, toneDiff <= 1, `ΔT=${f(toneDiff, 3)}`)
  check(`  chroma 被降低到色域内`, back.c < testCase.c, `${f(back.c, 1)} < ${testCase.c}`)
}

/* ================================================================== *
 * 4. 亮度单调性
 * ================================================================== */

section('4. 亮度单调性（同一色相下 tone 0→100 相对亮度严格递增）')

for (const hue of [0, 25, 60, 120, 200, 258, 300, 350]) {
  for (const chroma of [0, 48]) {
    let previous = -1
    let monotonic = true
    let badTone = -1
    for (let tone = 0; tone <= 100; tone += 2) {
      const rgb = hctToRgb(hue, chroma, tone)
      const lum = relativeLuminance(rgb)
      if (lum <= previous) {
        monotonic = false
        badTone = tone
        break
      }
      previous = lum
    }
    check(
      `hue=${hue} chroma=${chroma} 严格单调`,
      monotonic,
      monotonic ? '' : `在 tone=${badTone} 处不再递增`
    )
  }
}

/* ================================================================== *
 * 5. WCAG 对比度
 * ================================================================== */

section('5. WCAG 对比度（可读性底线 ≥ 4.5）')

const CONTRAST_PAIRS: Array<[string, string, string]> = [
  ['light', 'onPrimary', 'primary'],
  ['light', 'onSurface', 'surface'],
  ['light', 'onPrimaryContainer', 'primaryContainer'],
  ['light', 'onSurfaceVariant', 'surface'],
  ['light', 'onErrorContainer', 'errorContainer'],
  ['dark', 'onPrimary', 'primary'],
  ['dark', 'onSurface', 'surface'],
  ['dark', 'onPrimaryContainer', 'primaryContainer'],
  ['dark', 'onSurfaceVariant', 'surface'],
  ['dark', 'onErrorContainer', 'errorContainer']
]

for (const baseline of BASELINES) {
  const palette = buildPalette(baseline)
  console.log(`\n  ${baseline}`)
  for (const [mode, fgRole, bgRole] of CONTRAST_PAIRS) {
    const roles = mode === 'light' ? palette.light : palette.dark
    const fg = roles[fgRole as keyof typeof roles]
    const bg = roles[bgRole as keyof typeof roles]
    const ratio = contrastRatio(fg, bg)
    check(
      `  [${mode}] ${fgRole} (${fg}) on ${bgRole} (${bg}) ≥ 4.5`,
      ratio >= 4.5,
      `实测 ${f(ratio, 2)}:1`
    )
  }
}

/* ================================================================== *
 * 6. 壁纸取色
 * ================================================================== */

section('6. pickSeedFromBitmap（合成 BGRA 图）')

const VIVID_BLUE: [number, number, number] = [59, 130, 246] // #3B82F6
const GRAY: [number, number, number] = [128, 128, 128]

// 6.1 大面积灰 + 一小块鲜艳蓝
const grayBlue = makeBgra(200, 200, (x, y) => {
  const inBlue = x >= 80 && x < 128 && y >= 80 && y < 128
  const c = inBlue ? VIVID_BLUE : GRAY
  return [c[0], c[1], c[2], 255]
})
const picked1 = pickSeedFromBitmap(grayBlue, 200, 200)
console.log(`  灰底 + 蓝块 -> ${picked1 ?? 'null'}`)
check(
  '  灰底 + 鲜艳蓝块：返回蓝色而非灰色',
  picked1 !== null &&
    Math.max(...channelDelta(picked1, '#3B82F6').map((d) => Math.abs(d))) <= 6,
  `实际 ${picked1}`
)

// 6.2 全灰图 -> null
const allGray = makeBgra(120, 120, () => [GRAY[0], GRAY[1], GRAY[2], 255])
const picked2 = pickSeedFromBitmap(allGray, 120, 120)
console.log(`  全灰图 -> ${picked2 ?? 'null'}`)
check('  全灰图返回 null', picked2 === null, `实际 ${picked2}`)

// 6.3 大面积暗色 + 少量鲜艳橙色：应挑橙色（鲜艳度优先）
const darkOrange = makeBgra(160, 160, (x, y) => {
  const inOrange = x >= 120 && y >= 120
  const c: [number, number, number] = inOrange ? [255, 109, 0] : [16, 26, 60]
  return [c[0], c[1], c[2], 255]
})
const picked3 = pickSeedFromBitmap(darkOrange, 160, 160)
const picked3Hct = picked3 ? rgbToHct(hexToRgb(picked3)) : null
console.log(
  `  暗底 + 橙块 -> ${picked3 ?? 'null'}` +
    (picked3Hct ? `  HCT(h=${f(picked3Hct.h, 1)}, c=${f(picked3Hct.c, 1)}, t=${f(picked3Hct.t, 1)})` : '')
)
check(
  '  暗底 + 橙块：返回橙色（hue 在 20-50 之间）',
  picked3Hct !== null && hueDistance(picked3Hct.h, 35) <= 15,
  `实际 ${picked3}`
)

// 6.4 全透明 / 非法尺寸 / 缓冲区长度不匹配
const transparent = makeBgra(40, 40, () => [255, 0, 0, 0])
check('  全透明图返回 null', pickSeedFromBitmap(transparent, 40, 40) === null)
check('  尺寸为 0 返回 null', pickSeedFromBitmap(Buffer.alloc(0), 0, 0) === null)
check('  宽度为 0 返回 null', pickSeedFromBitmap(Buffer.alloc(16), 0, 4) === null)
check(
  '  缓冲区长度与 width*height*4 不匹配返回 null',
  pickSeedFromBitmap(Buffer.alloc(10), 100, 100) === null
)
check(
  '  空 buffer 返回 null',
  pickSeedFromBitmap(new Uint8Array(0), 4, 4) === null
)
check(
  '  非有限尺寸返回 null',
  pickSeedFromBitmap(Buffer.alloc(16), Number.NaN, 4) === null
)

// 6.5 支持 Uint8Array（非 Node Buffer）
const uint8 = new Uint8Array(grayBlue.buffer, grayBlue.byteOffset, grayBlue.byteLength)
check(
  '  接受 Uint8Array 输入',
  pickSeedFromBitmap(uint8, 200, 200) === picked1,
  `${pickSeedFromBitmap(uint8, 200, 200)}`
)

// 6.6 大图性能（降采样后应远快于逐像素 HCT）
const bigImage = makeBgra(1920, 1080, (x, y) => {
  const inBlue = x > 900 && x < 1100 && y > 400 && y < 700
  const c: [number, number, number] = inBlue ? VIVID_BLUE : [200, 190, 180]
  return [c[0], c[1], c[2], 255]
})
const t0 = Date.now()
const picked4 = pickSeedFromBitmap(bigImage, 1920, 1080)
const pickMs = Date.now() - t0
console.log(`  1920x1080 合成壁纸 -> ${picked4 ?? 'null'}  (${pickMs} ms)`)
check('  1920x1080 取色在 2000ms 内完成', pickMs < 2000, `${pickMs} ms`)
check(
  '  1920x1080 取色返回蓝色',
  picked4 !== null &&
    Math.max(...channelDelta(picked4, '#3B82F6').map((d) => Math.abs(d))) <= 6,
  `实际 ${picked4}`
)

/* ================================================================== *
 * 7. 健壮性
 * ================================================================== */

section('7. 健壮性')

const HEX_CASES: Array<[string, string | null]> = [
  ['#6750a4', '#6750A4'],
  ['6750A4', '#6750A4'],
  ['  #6750A4  ', '#6750A4'],
  ['#abc', '#AABBCC'],
  ['#FF6750A4', '#6750A4'],
  ['', null],
  ['#', null],
  ['#12345', null],
  ['#1234567', null],
  ['#GGGGGG', null],
  ['not-a-color', null],
  ['rgb(1,2,3)', null]
]

for (const [input, expected] of HEX_CASES) {
  const actual = normalizeHex(input)
  check(`  normalizeHex(${JSON.stringify(input)}) === ${expected}`, actual === expected, `实际 ${actual}`)
}
check('  normalizeHex(undefined as any) === null', normalizeHex(undefined as unknown as string) === null)
check(
  '  hexToRgb(非法) 返回 {0,0,0} 而不抛异常',
  JSON.stringify(hexToRgb('nope')) === JSON.stringify({ r: 0, g: 0, b: 0 })
)

const BAD_SEEDS = ['', 'nope', '#FFFFFF', '#000000', '#808080', '#7F7F7F', '#FEFEFE']
for (const bad of BAD_SEEDS) {
  const palette = buildPalette(bad)
  const allRoles = [...Object.values(palette.light), ...Object.values(palette.dark)]
  const shapeOk = allRoles.every((v) => typeof v === 'string' && /^#[0-9A-F]{6}$/.test(v))
  check(
    `  buildPalette(${JSON.stringify(bad)}) 回退到默认种子且色板完整`,
    shapeOk && palette.seed === '#6750A4',
    `seed=${palette.seed}`
  )
}

const clampPalette = buildPalette('#0000FF')
check(
  '  buildPalette 对高彩度色仍产出合法色板',
  [...Object.values(clampPalette.light), ...Object.values(clampPalette.dark)].every((v) =>
    /^#[0-9A-F]{6}$/.test(v)
  ),
  `seed=${clampPalette.seed}`
)

const whitePalette = buildPalette('#FFFFFF')
check(
  '  纯白种子回退到 #6750A4',
  whitePalette.seed === '#6750A4',
  `实际 ${whitePalette.seed}`
)

// 随机种子批量校验：色板结构合法 + 对比度底线始终成立
{
  const SEED_COUNT = 300
  let shapeFailures = 0
  let contrastFailures = 0
  let worstContrast = Infinity
  let worstLabel = ''
  const seenSeeds = new Set<string>()

  for (let i = 0; i < SEED_COUNT; i++) {
    const seed = hex({
      r: Math.floor(rnd() * 256),
      g: Math.floor(rnd() * 256),
      b: Math.floor(rnd() * 256)
    })
    seenSeeds.add(seed)
    const palette = buildPalette(seed)
    const rolesLight = palette.light
    const rolesDark = palette.dark
    for (const value of [...Object.values(rolesLight), ...Object.values(rolesDark)]) {
      if (!/^#[0-9A-F]{6}$/.test(value)) shapeFailures++
    }
    const pairs: Array<[string, keyof typeof rolesLight, keyof typeof rolesLight]> = [
      ['light', 'onPrimary', 'primary'],
      ['light', 'onSurface', 'surface'],
      ['light', 'onPrimaryContainer', 'primaryContainer'],
      ['light', 'onSurfaceVariant', 'surface'],
      ['light', 'onErrorContainer', 'errorContainer'],
      ['dark', 'onPrimary', 'primary'],
      ['dark', 'onSurface', 'surface'],
      ['dark', 'onPrimaryContainer', 'primaryContainer'],
      ['dark', 'onSurfaceVariant', 'surface'],
      ['dark', 'onErrorContainer', 'errorContainer']
    ]
    for (const [mode, fgRole, bgRole] of pairs) {
      const roles = mode === 'light' ? rolesLight : rolesDark
      const ratio = contrastRatio(roles[fgRole], roles[bgRole])
      if (ratio < worstContrast) {
        worstContrast = ratio
        worstLabel = `${seed} ${mode} ${fgRole}/${bgRole}`
      }
      if (ratio < 4.5) contrastFailures++
    }
  }

  check(
    `${SEED_COUNT} 个随机种子生成的色板结构全部合法`,
    shapeFailures === 0,
    `非法值 ${shapeFailures} 个`
  )
  check(
    `${SEED_COUNT} 个随机种子的 ${SEED_COUNT * 10} 组对比度全部 ≥ 4.5`,
    contrastFailures === 0,
    `最差 ${f(worstContrast, 2)}:1 @ ${worstLabel}`
  )
  console.log(`  随机种子覆盖 ${seenSeeds.size} 个不同颜色`)
}

/* ================================================================== *
 * 8. M3 公开基线色板对照（Material Theme Builder / m3.material.io）
 * ================================================================== */

section('8. 与 M3 公开基线色板对照（seed #6750A4，逐通道 Δ）')

const M3_PUBLISHED_LIGHT: Record<string, string> = {
  primary: '#6750A4',
  onPrimary: '#FFFFFF',
  primaryContainer: '#EADDFF',
  onPrimaryContainer: '#21005D',
  surface: '#FEF7FF',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F7F2FA',
  surfaceContainer: '#F3EDF7',
  surfaceContainerHigh: '#ECE6F0',
  surfaceContainerHighest: '#E6E0E9',
  onSurface: '#1D1B20',
  onSurfaceVariant: '#49454F',
  outline: '#79747E',
  outlineVariant: '#CAC4D0',
  error: '#BA1A1A',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002'
}

const M3_PUBLISHED_DARK: Record<string, string> = {
  primary: '#CFBCFF',
  onPrimary: '#381E72',
  primaryContainer: '#4F378A',
  onPrimaryContainer: '#E9DDFF',
  surface: '#141218',
  surfaceContainerLowest: '#0F0D13',
  surfaceContainerLow: '#1D1B20',
  surfaceContainer: '#211F26',
  surfaceContainerHigh: '#2B2930',
  surfaceContainerHighest: '#36343B',
  onSurface: '#E6E0E9',
  onSurfaceVariant: '#CAC4D0',
  outline: '#938F99',
  outlineVariant: '#49454F',
  error: '#FFB4AB',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6'
}

/**
 * 分组容差：
 *  - primary / error 家族（chroma 高）：M3 与本模块应几乎完全一致（±2）
 *  - neutralVariant 家族（chroma 8）：±2
 *  - neutral 家族（chroma 4）：±6。M3 公开基线里的中性色实测 HCT chroma ≈ 6，
 *    而本模块按需求使用规范值 chroma 4，因此中性色会比公开基线略淡一点。
 */
const FAMILY: Record<string, { family: string; tolerance: number }> = {
  primary: { family: 'primary', tolerance: 2 },
  onPrimary: { family: 'primary', tolerance: 2 },
  primaryContainer: { family: 'primary', tolerance: 2 },
  onPrimaryContainer: { family: 'primary', tolerance: 2 },
  error: { family: 'primary', tolerance: 2 },
  errorContainer: { family: 'primary', tolerance: 2 },
  onErrorContainer: { family: 'primary', tolerance: 2 },
  onSurfaceVariant: { family: 'neutralVariant', tolerance: 2 },
  outline: { family: 'neutralVariant', tolerance: 2 },
  outlineVariant: { family: 'neutralVariant', tolerance: 2 },
  surface: { family: 'neutral', tolerance: 6 },
  surfaceContainerLowest: { family: 'neutral', tolerance: 6 },
  surfaceContainerLow: { family: 'neutral', tolerance: 6 },
  surfaceContainer: { family: 'neutral', tolerance: 6 },
  surfaceContainerHigh: { family: 'neutral', tolerance: 6 },
  surfaceContainerHighest: { family: 'neutral', tolerance: 6 },
  onSurface: { family: 'neutral', tolerance: 6 }
}

const referencePalette = buildPalette('#6750A4')
for (const [mode, published] of [
  ['light', M3_PUBLISHED_LIGHT],
  ['dark', M3_PUBLISHED_DARK]
] as const) {
  const roles = referencePalette[mode]
  const worstByFamily = new Map<string, { delta: number; role: string }>()
  console.log(`\n  #6750A4 / ${mode}`)
  console.log(`  ${'role'.padEnd(26)}${'ours'.padEnd(11)}${'M3'.padEnd(11)}ΔRGB`)
  for (const key of Object.keys(published)) {
    const ours = roles[key as keyof typeof roles]
    const delta = channelDelta(ours, published[key])
    const maxDelta = Math.max(...delta.map((d) => Math.abs(d)))
    const info = FAMILY[key]
    const previous = worstByFamily.get(info.family)
    if (!previous || maxDelta > previous.delta) {
      worstByFamily.set(info.family, { delta: maxDelta, role: key })
    }
    console.log(
      `  ${key.padEnd(26)}${ours.padEnd(11)}${published[key].padEnd(11)}[${delta.join(', ')}]`
    )
  }
  for (const [family, worst] of worstByFamily) {
    const tolerance = family === 'neutral' ? 6 : 2
    check(
      `  ${mode} / ${family} 家族与 M3 公开基线最大通道偏差 ≤ ${tolerance}`,
      worst.delta <= tolerance,
      `max|Δ|=${worst.delta} @ ${worst.role}`
    )
  }
}

console.log('\n  说明：M3 公开基线中性色的实测 HCT chroma（用本模块反推）：')
for (const color of ['#FEF7FF', '#F7F2FA', '#E6E0E9', '#1D1B20', '#79747E', '#CAC4D0']) {
  const hct = rgbToHct(hexToRgb(color))
  console.log(`    ${color}  H=${f(hct.h, 2)}  C=${f(hct.c, 2)}  T=${f(hct.t, 2)}`)
}
console.log('  即公开基线中性色 ≈ (hue 跟随种子, chroma≈6)；本模块按需求使用规范值 chroma 4。')

/* ================================================================== *
 * 9. 打印完整色板
 * ================================================================== */

section('9. buildPalette("#6750A4") 完整色板')

for (const baseline of BASELINES) {
  const palette = buildPalette(baseline)
  for (const mode of ['light', 'dark'] as const) {
    const roles = palette[mode]
    console.log(`\n  ${baseline} / ${mode}   (seed = ${palette.seed})`)
    console.log(`  ${'role'.padEnd(26)}${'hex'.padEnd(12)}${'rgb'.padEnd(18)}tone   swatch`)
    for (const key of Object.keys(roles) as Array<keyof typeof roles>) {
      const value = roles[key]
      const rgb = hexToRgb(value)
      const tone = rgbToHct(rgb).t
      console.log(
        `  ${key.padEnd(26)}${value.padEnd(12)}` +
          `${`${rgb.r},${rgb.g},${rgb.b}`.padEnd(18)}${f(tone, 1).padStart(5)}  ${swatch(value)}`
      )
    }
  }
}

section('10. #6750A4 主色板关键 tone 输出')

const seedHct = rgbToHct(hexToRgb('#6750A4'))
const KEY_TONES = [0, 4, 6, 10, 12, 17, 20, 22, 30, 40, 50, 60, 70, 80, 90, 92, 94, 96, 98, 100]
console.log(
  `  primary palette  H=${f(seedHct.h)}  C=${f(seedHct.c)}\n` +
    `  ${'tone'.padEnd(6)}${'hex'.padEnd(12)}实际 tone   swatch`
)
for (const tone of KEY_TONES) {
  const value = hex(hctToRgb(seedHct.h, seedHct.c, tone))
  const actualTone = rgbToHct(hexToRgb(value)).t
  console.log(
    `  ${String(tone).padEnd(6)}${value.padEnd(12)}${f(actualTone, 2).padStart(9)}   ${swatch(value)}`
  )
}

const neutralHct = rgbToHct(hexToRgb('#6750A4'))
console.log(`\n  neutral palette (H=${f(neutralHct.h)}, C=4)`)
for (const tone of KEY_TONES) {
  const value = hex(hctToRgb(neutralHct.h, 4, tone))
  console.log(`  ${String(tone).padEnd(6)}${value.padEnd(12)}   ${swatch(value)}`)
}

/* ================================================================== *
 * 11. HCT 参考值对照（material-color-utilities 测试向量）
 * ================================================================== */

section('11. HCT 参考值对照（material-color-utilities 测试向量）')

const HCT_REFERENCE: Array<[string, number, number, number]> = [
  ['#FF0000', 27.408, 113.357, 53.233],
  ['#00FF00', 142.139, 108.41, 87.737],
  ['#0000FF', 282.788, 87.23, 32.303]
]

for (const [color, hue, chroma, tone] of HCT_REFERENCE) {
  const hct = rgbToHct(hexToRgb(color))
  const dh = hueDistance(hct.h, hue)
  const dc = Math.abs(hct.c - chroma)
  const dt = Math.abs(hct.t - tone)
  console.log(
    `  ${color}  实测 H=${f(hct.h, 3)} C=${f(hct.c, 3)} T=${f(hct.t, 3)}` +
      `  | 参考 H=${hue} C=${chroma} T=${tone}  Δ=(${f(dh, 2)}, ${f(dc, 2)}, ${f(dt, 2)})`
  )
  check(`  ${color} 与参考值一致（ΔH ≤ 0.1, ΔC ≤ 0.1, ΔT ≤ 0.1）`, dh <= 0.1 && dc <= 0.1 && dt <= 0.1)
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section('结果')
console.log(`  断言 ${checks} 条，失败 ${failures} 条`)

const t1 = Date.now()
for (let i = 0; i < 5; i++) buildPalette(`#${(0x100000 + i * 0x010203).toString(16).toUpperCase()}`)
console.log(`  buildPalette 冷启动平均耗时 ${f((Date.now() - t1) / 5, 1)} ms（含缓存未命中）`)

process.exitCode = failures > 0 ? 1 : 0
console.log(failures > 0 ? '\n  ✗ 存在失败断言' : '\n  ✓ 全部通过')
