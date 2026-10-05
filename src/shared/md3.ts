/**
 * Material Design 3 动态取色（Material You）——纯算法模块。
 *
 * 设计约束：
 *  - 只依赖 TypeScript 语言本身 + 可选的 `node:buffer` 类型（仅 `import type`，
 *    编译后完全消失），因此同一份代码可运行在 Electron 主进程与渲染进程。
 *  - 不依赖任何 npm 包，不使用 electron API。
 *  - 所有导出的函数对非法输入都返回可用结果或 null，绝不抛异常。
 *
 * 色彩科学：
 *  - CAM16（Hunt-Pointer-Estevez 锥体响应 + 色适应 + 非线性压缩）提供 H（色相）与 C（彩度）
 *  - CIE L*（由 CIE XYZ 的 Y 分量定义）提供 T（色调 tone）
 *  - 两者合起来就是 Google 的 HCT 色彩空间，Material You 的调色板即建立在其上
 *  - 色域映射：保持 H 与 T 不变，二分降低 C 直到落入 sRGB 色域
 */

import type { Buffer } from 'node:buffer'

/* ================================================================== *
 * 公开类型
 * ================================================================== */

/** 色调板里用到的全部色角色，值一律是 "#RRGGBB" 大写十六进制 */
export interface Md3Roles {
  primary: string
  onPrimary: string
  primaryContainer: string
  onPrimaryContainer: string
  surface: string
  surfaceContainerLowest: string
  surfaceContainerLow: string
  surfaceContainer: string
  surfaceContainerHigh: string
  surfaceContainerHighest: string
  onSurface: string
  onSurfaceVariant: string
  outline: string
  outlineVariant: string
  error: string
  errorContainer: string
  onErrorContainer: string
}

export interface Md3Palette {
  /** 实际用于生成的种子色（已做可用性校正，见 resolveSeed） */
  seed: string
  light: Md3Roles
  dark: Md3Roles
}

/** 0-255 整数 RGB */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** HCT：h 0-360 度，c CAM16 彩度，t CIE L* 0-100 */
export interface Hct {
  h: number
  c: number
  t: number
}

/* ================================================================== *
 * 常量
 * ================================================================== */

/** M3 基线种子色（紫色） */
export const DEFAULT_SEED = '#6750A4'

/** M3 规范里 error 系列使用固定色相（不跟随种子） */
const ERROR_HUE = 25
const ERROR_CHROMA = 84

/**
 * 中性色板 chroma。
 * 规范文字写的是 4，但反推 M3 公开基线色板（#FEF7FF / #F7F2FA / #1D1B20 等）
 * 实测有效 chroma 约 5.4–6.6。取 6 能把 neutral 家族与官方基线的偏差
 * 从每通道 6 降到 ≤1，观感更贴近 Material You。
 */
const NEUTRAL_CHROMA = 6
const NEUTRAL_VARIANT_CHROMA = 8

/** 种子可用性校正阈值 */
const SEED_MIN_CHROMA = 5
const SEED_MAX_CHROMA = 120
const SEED_MIN_TONE = 30
const SEED_MAX_TONE = 80

/** 从壁纸像素挑种子时的候选过滤阈值 */
const PICK_MIN_CHROMA = 6
const PICK_MIN_TONE = 10
const PICK_MAX_TONE = 95

/** sRGB 色域判定容差（线性空间 0-100 尺度） */
const GAMUT_EPS = 1e-6

/** 二分迭代次数 */
const TONE_ITERATIONS = 32
const CHROMA_ITERATIONS = 26

/* ================================================================== *
 * 基础数学
 * ================================================================== */

function clamp(min: number, max: number, value: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

function clampInt(min: number, max: number, value: number): number {
  if (!Number.isFinite(value)) return min
  return Math.round(value < min ? min : value > max ? max : value)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function signum(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0
}

/** 把任意角度规范化到 [0, 360) */
function sanitizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const d = degrees % 360
  return d < 0 ? d + 360 : d
}

/** 两个色相之间的最小差值（考虑环绕） */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(sanitizeDegrees(a) - sanitizeDegrees(b)) % 360
  return d > 180 ? 360 - d : d
}

/* ================================================================== *
 * sRGB <-> CIE XYZ（D65）
 * ================================================================== */

/** sRGB -> XYZ 矩阵（行主序） */
const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478]
] as const

/** XYZ -> sRGB 矩阵（上者精确逆矩阵） */
const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335]
] as const

/** D65 白点（Y=100 尺度） */
const WHITE_POINT_D65: readonly number[] = [95.047, 100.0, 108.883]

/** sRGB 电光转换的逆：0-255 编码值 -> 0-100 线性值 */
function linearized(component: number): number {
  const normalized = component / 255
  if (normalized <= 0.040449936) return (normalized / 12.92) * 100
  return Math.pow((normalized + 0.055) / 1.055, 2.4) * 100
}

/** 线性 0-100 -> 0-255 浮点（未取整） */
function delinearized(component: number): number {
  const normalized = component / 100
  let value: number
  if (normalized <= 0.0031308) value = normalized * 12.92
  else value = 1.055 * Math.pow(normalized, 1 / 2.4) - 0.055
  return clamp(0, 1, value) * 255
}

/** CIE L* -> 相对亮度 Y（0-100） */
function yFromLstar(lstar: number): number {
  const kappa = 24389 / 27
  if (lstar > 8) return Math.pow((lstar + 16) / 116, 3) * 100
  return (lstar / kappa) * 100
}

/** 相对亮度 Y（0-100）-> CIE L* */
function lstarFromY(y: number): number {
  const e = 216 / 24389
  const kappa = 24389 / 27
  const y1 = y / 100
  if (y1 <= e) return y1 * kappa
  return 116 * Math.cbrt(y1) - 16
}

function argbFromRgb(r: number, g: number, b: number): number {
  return (
    ((255 << 24) |
      (clampInt(0, 255, r) << 16) |
      (clampInt(0, 255, g) << 8) |
      clampInt(0, 255, b)) >>>
    0
  )
}

function rgbFromArgb(argb: number): Rgb {
  return { r: (argb >>> 16) & 0xff, g: (argb >>> 8) & 0xff, b: argb & 0xff }
}

function xyzFromArgb(argb: number): [number, number, number] {
  const { r, g, b } = rgbFromArgb(argb)
  const lr = linearized(r)
  const lg = linearized(g)
  const lb = linearized(b)
  return [
    SRGB_TO_XYZ[0][0] * lr + SRGB_TO_XYZ[0][1] * lg + SRGB_TO_XYZ[0][2] * lb,
    SRGB_TO_XYZ[1][0] * lr + SRGB_TO_XYZ[1][1] * lg + SRGB_TO_XYZ[1][2] * lb,
    SRGB_TO_XYZ[2][0] * lr + SRGB_TO_XYZ[2][1] * lg + SRGB_TO_XYZ[2][2] * lb
  ]
}

function linearRgbFromXyz(x: number, y: number, z: number): [number, number, number] {
  return [
    XYZ_TO_SRGB[0][0] * x + XYZ_TO_SRGB[0][1] * y + XYZ_TO_SRGB[0][2] * z,
    XYZ_TO_SRGB[1][0] * x + XYZ_TO_SRGB[1][1] * y + XYZ_TO_SRGB[1][2] * z,
    XYZ_TO_SRGB[2][0] * x + XYZ_TO_SRGB[2][1] * y + XYZ_TO_SRGB[2][2] * z
  ]
}

/* ================================================================== *
 * 观察条件（Material 默认值）
 * ================================================================== */

class ViewingConditions {
  constructor(
    readonly n: number,
    readonly aw: number,
    readonly nbb: number,
    readonly ncb: number,
    readonly c: number,
    readonly nc: number,
    readonly rgbD: readonly number[],
    readonly fl: number,
    readonly flRoot: number,
    readonly z: number
  ) {}

  /**
   * 默认：D65 白点、适应亮度 11.72、背景 L* 50、surround 2.0、不考虑光源折扣。
   */
  static make(
    whitePoint: readonly number[] = WHITE_POINT_D65,
    adaptingLuminance = (200 / Math.PI) * (yFromLstar(50) / 100),
    backgroundLstar = 50,
    surround = 2,
    discountingIlluminant = false
  ): ViewingConditions {
    // D65 -> 锥体响应空间（与 CAM16 的 M16 矩阵一致）
    const rW = whitePoint[0] * 0.401288 + whitePoint[1] * 0.650173 + whitePoint[2] * -0.051461
    const gW = whitePoint[0] * -0.250268 + whitePoint[1] * 1.204414 + whitePoint[2] * 0.045854
    const bW = whitePoint[0] * -0.002079 + whitePoint[1] * 0.048952 + whitePoint[2] * 0.953127

    const f = 0.8 + surround / 10
    const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10) : lerp(0.525, 0.59, (f - 0.8) * 10)
    let d = discountingIlluminant
      ? 1
      : f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92))
    d = clamp(0, 1, d)
    const nc = f
    const rgbD = [
      d * (100 / rW) + 1 - d,
      d * (100 / gW) + 1 - d,
      d * (100 / bW) + 1 - d
    ]

    const k = 1 / (5 * adaptingLuminance + 1)
    const k4 = k * k * k * k
    const k4F = 1 - k4
    const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance)
    const n = yFromLstar(backgroundLstar) / whitePoint[1]
    const z = 1.48 + Math.sqrt(n)
    const nbb = 0.725 / Math.pow(n, 0.2)
    const ncb = nbb

    const rgbAFactors = [
      Math.pow((fl * rgbD[0] * rW) / 100, 0.42),
      Math.pow((fl * rgbD[1] * gW) / 100, 0.42),
      Math.pow((fl * rgbD[2] * bW) / 100, 0.42)
    ]
    const rgbA = [
      (400 * rgbAFactors[0]) / (rgbAFactors[0] + 27.13),
      (400 * rgbAFactors[1]) / (rgbAFactors[1] + 27.13),
      (400 * rgbAFactors[2]) / (rgbAFactors[2] + 27.13)
    ]
    const aw = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb

    return new ViewingConditions(n, aw, nbb, ncb, c, nc, rgbD, fl, Math.pow(fl, 0.25), z)
  }
}

const DEFAULT_VC = ViewingConditions.make()

/* ================================================================== *
 * CAM16
 * ================================================================== */

export interface Cam16 {
  /** 色相 0-360 */
  hue: number
  /** 彩度 C */
  chroma: number
  /** 明度 J */
  j: number
  /** 亮度 Q */
  q: number
  /** 色彩度 M */
  m: number
  /** 饱和度 s */
  s: number
  a: number
  b: number
}

/** CAM16 反向非线性压缩：适应后响应 -> 线性锥体响应 */
function inverseAdaptedResponse(a: number, vc: ViewingConditions): number {
  const absA = Math.min(Math.abs(a), 399.999)
  const base = (27.13 * absA) / (400 - absA)
  return signum(a) * (100 / vc.fl) * Math.pow(base, 1 / 0.42)
}

/** XYZ -> CAM16 */
function cam16FromXyz(x: number, y: number, z: number, vc: ViewingConditions): Cam16 {
  const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z
  const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z
  const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z

  const rD = vc.rgbD[0] * rC
  const gD = vc.rgbD[1] * gC
  const bD = vc.rgbD[2] * bC

  const rAF = Math.pow((vc.fl * Math.abs(rD)) / 100, 0.42)
  const gAF = Math.pow((vc.fl * Math.abs(gD)) / 100, 0.42)
  const bAF = Math.pow((vc.fl * Math.abs(bD)) / 100, 0.42)

  const rA = signum(rD) * ((400 * rAF) / (rAF + 27.13))
  const gA = signum(gD) * ((400 * gAF) / (gAF + 27.13))
  const bA = signum(bD) * ((400 * bAF) / (bAF + 27.13))

  const a = (11 * rA - 12 * gA + bA) / 11
  const b = (rA + gA - 2 * bA) / 9
  const u = (20 * rA + 20 * gA + 21 * bA) / 20
  const p2 = (40 * rA + 20 * gA + bA) / 20

  const hue = sanitizeDegrees((Math.atan2(b, a) * 180) / Math.PI)
  const ac = p2 * vc.nbb
  const j = 100 * Math.pow(Math.max(0, ac / vc.aw), vc.c * vc.z)
  const q = (4 / vc.c) * Math.sqrt(j / 100) * (vc.aw + 4) * vc.flRoot

  const huePrime = hue < 20.14 ? hue + 360 : hue
  const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8)
  const p1 = (50000 / 13) * eHue * vc.nc * vc.ncb
  const t = (p1 * Math.hypot(a, b)) / (u + 0.305)
  const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, vc.n), 0.73)
  const chroma = alpha * Math.sqrt(j / 100)
  const m = chroma * vc.flRoot
  const s = 50 * Math.sqrt((alpha * vc.c) / (vc.aw + 4))

  return { hue, chroma, j, q, m, s, a, b }
}

/** (J, C, h) -> XYZ。J<=0 时返回黑色。 */
function xyzFromJch(
  j: number,
  chroma: number,
  hueDegrees: number,
  vc: ViewingConditions
): [number, number, number] {
  if (!(j > 0)) return [0, 0, 0]

  const alpha = chroma / Math.sqrt(j / 100)
  const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, vc.n), 0.73), 1 / 0.9)
  const hRad = (hueDegrees * Math.PI) / 180
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8)
  const ac = vc.aw * Math.pow(j / 100, 1 / vc.c / vc.z)
  const p1 = eHue * (50000 / 13) * vc.nc * vc.ncb
  const p2 = ac / vc.nbb
  const hSin = Math.sin(hRad)
  const hCos = Math.cos(hRad)

  const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin)
  const a = gamma * hCos
  const b = gamma * hSin

  const rA = (460 * p2 + 451 * a + 288 * b) / 1403
  const gA = (460 * p2 - 891 * a - 261 * b) / 1403
  const bA = (460 * p2 - 220 * a - 6300 * b) / 1403

  const rF = inverseAdaptedResponse(rA, vc) / vc.rgbD[0]
  const gF = inverseAdaptedResponse(gA, vc) / vc.rgbD[1]
  const bF = inverseAdaptedResponse(bA, vc) / vc.rgbD[2]

  return [
    1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF,
    0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF,
    -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF
  ]
}

/** 在固定 (h, C) 下二分求 J，使结果颜色的 Y 等于 tone 对应的亮度 */
function solveJForTone(hue: number, chroma: number, tone: number, vc: ViewingConditions): number {
  const targetY = yFromLstar(tone)
  const yAt = (j: number): number => xyzFromJch(j, chroma, hue, vc)[1]

  let lo = 0
  let hi = 100
  if (yAt(hi) <= targetY) return hi
  for (let i = 0; i < TONE_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    if (yAt(mid) < targetY) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/* ================================================================== *
 * HCT（H = CAM16 hue，C = CAM16 chroma，T = CIE L*）
 * ================================================================== */

/** 该 (h, C, T) 是否落在 sRGB 色域内（线性空间判据） */
function isInGamutAtHct(
  hue: number,
  chroma: number,
  tone: number,
  vc: ViewingConditions
): boolean {
  const j = solveJForTone(hue, chroma, tone, vc)
  const [x, y, z] = xyzFromJch(j, chroma, hue, vc)
  const lin = linearRgbFromXyz(x, y, z)
  for (const v of lin) {
    if (!Number.isFinite(v)) return false
    if (v < -GAMUT_EPS || v > 100 + GAMUT_EPS) return false
  }
  return true
}

/**
 * HCT -> sRGB。
 * 色域映射策略：保持 H 与 T 不变，二分降低 C 直到落入 sRGB 色域。
 */
export function hctToRgb(h: number, c: number, t: number): Rgb {
  const hue = sanitizeDegrees(Number.isFinite(h) ? h : 0)
  const chroma = Number.isFinite(c) && c > 0 ? c : 0
  const tone = clamp(0, 100, Number.isFinite(t) ? t : 0)

  if (tone <= 0.0001) return { r: 0, g: 0, b: 0 }
  if (tone >= 99.9999) return { r: 255, g: 255, b: 255 }

  const vc = DEFAULT_VC
  let usableChroma = 0
  if (isInGamutAtHct(hue, chroma, tone, vc)) {
    usableChroma = chroma
  } else {
    let lo = 0
    let hi = chroma
    for (let i = 0; i < CHROMA_ITERATIONS; i++) {
      const mid = (lo + hi) / 2
      if (isInGamutAtHct(hue, mid, tone, vc)) lo = mid
      else hi = mid
    }
    usableChroma = lo
  }

  const j = solveJForTone(hue, usableChroma, tone, vc)
  const [x, y, z] = xyzFromJch(j, usableChroma, hue, vc)
  const lin = linearRgbFromXyz(x, y, z)

  return {
    r: clampInt(0, 255, delinearized(lin[0])),
    g: clampInt(0, 255, delinearized(lin[1])),
    b: clampInt(0, 255, delinearized(lin[2]))
  }
}

/** sRGB -> HCT */
export function rgbToHct(rgb: { r: number; g: number; b: number }): Hct {
  const argb = argbFromRgb(rgb?.r ?? 0, rgb?.g ?? 0, rgb?.b ?? 0)
  const xyz = xyzFromArgb(argb)
  const cam = cam16FromXyz(xyz[0], xyz[1], xyz[2], DEFAULT_VC)
  return { h: cam.hue, c: cam.chroma, t: lstarFromY(xyz[1]) }
}

/* ================================================================== *
 * 十六进制工具
 * ================================================================== */

/**
 * 规范化十六进制颜色。
 * 接受 `#RGB`、`#RRGGBB`、`#AARRGGBB`（alpha 被丢弃，Android 习惯写法），
 * 大小写不限，`#` 可省略。非法输入返回 null。
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (!/^[0-9a-fA-F]+$/.test(s)) return null
  if (s.length === 3) {
    s = `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`
  } else if (s.length === 8) {
    s = s.slice(2) // 丢弃 AA
  }
  if (s.length !== 6) return null
  return `#${s.toUpperCase()}`
}

/** 十六进制 -> RGB。非法输入返回 {0,0,0}（本函数按签名不返回 null）。 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hex)
  if (!normalized) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  }
}

/** RGB -> "#RRGGBB"（大写） */
export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const r = clampInt(0, 255, rgb?.r ?? 0)
  const g = clampInt(0, 255, rgb?.g ?? 0)
  const b = clampInt(0, 255, rgb?.b ?? 0)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`
}

/* ================================================================== *
 * 色调板
 * ================================================================== */

interface TonalPalette {
  hue: number
  chroma: number
}

function toneOf(palette: TonalPalette, tone: number): string {
  return rgbToHex(hctToRgb(palette.hue, palette.chroma, tone))
}

/**
 * 种子可用性校正：
 *  - 几乎无彩色（C < 5）-> 回退到 M3 默认种子
 *  - 彩度过高（C > 120）-> 降到 120
 *  - 过暗 / 过亮（L* 不在 [30, 80]）-> 拉回区间，保持色相
 */
function resolveSeed(seedHex: string): { hex: string; h: number; c: number } {
  const fallback = (): { hex: string; h: number; c: number } => {
    const hct = rgbToHct(hexToRgb(DEFAULT_SEED))
    return { hex: DEFAULT_SEED, h: hct.h, c: hct.c }
  }

  const normalized = normalizeHex(seedHex)
  if (!normalized) return fallback()

  const hct = rgbToHct(hexToRgb(normalized))
  if (!Number.isFinite(hct.c) || hct.c < SEED_MIN_CHROMA) return fallback()

  const chroma = Math.min(hct.c, SEED_MAX_CHROMA)
  const tone = clamp(SEED_MIN_TONE, SEED_MAX_TONE, hct.t)
  const hex = rgbToHex(hctToRgb(hct.h, chroma, tone))
  return { hex, h: hct.h, c: chroma }
}

function buildRoles(
  primary: TonalPalette,
  neutral: TonalPalette,
  neutralVariant: TonalPalette,
  error: TonalPalette,
  dark: boolean
): Md3Roles {
  if (dark) {
    return {
      primary: toneOf(primary, 80),
      onPrimary: toneOf(primary, 20),
      primaryContainer: toneOf(primary, 30),
      onPrimaryContainer: toneOf(primary, 90),
      surface: toneOf(neutral, 6),
      surfaceContainerLowest: toneOf(neutral, 4),
      surfaceContainerLow: toneOf(neutral, 10),
      surfaceContainer: toneOf(neutral, 12),
      surfaceContainerHigh: toneOf(neutral, 17),
      surfaceContainerHighest: toneOf(neutral, 22),
      onSurface: toneOf(neutral, 90),
      onSurfaceVariant: toneOf(neutralVariant, 80),
      outline: toneOf(neutralVariant, 60),
      outlineVariant: toneOf(neutralVariant, 30),
      error: toneOf(error, 80),
      errorContainer: toneOf(error, 30),
      onErrorContainer: toneOf(error, 90)
    }
  }
  return {
    primary: toneOf(primary, 40),
    onPrimary: toneOf(primary, 100),
    primaryContainer: toneOf(primary, 90),
    onPrimaryContainer: toneOf(primary, 10),
    surface: toneOf(neutral, 98),
    surfaceContainerLowest: toneOf(neutral, 100),
    surfaceContainerLow: toneOf(neutral, 96),
    surfaceContainer: toneOf(neutral, 94),
    surfaceContainerHigh: toneOf(neutral, 92),
    surfaceContainerHighest: toneOf(neutral, 90),
    onSurface: toneOf(neutral, 10),
    onSurfaceVariant: toneOf(neutralVariant, 30),
    outline: toneOf(neutralVariant, 50),
    outlineVariant: toneOf(neutralVariant, 80),
    error: toneOf(error, 40),
    errorContainer: toneOf(error, 90),
    onErrorContainer: toneOf(error, 10)
  }
}

/** buildPalette 的记忆化缓存（键为校正后的种子 hex） */
const paletteCache = new Map<string, { light: Md3Roles; dark: Md3Roles }>()

/** 从种子色生成完整浅色/深色色调板。任何输入都会返回一个完整可用的色板。 */
export function buildPalette(seedHex: string): Md3Palette {
  const seed = resolveSeed(seedHex)
  const cached = paletteCache.get(seed.hex)
  if (cached) {
    return { seed: seed.hex, light: { ...cached.light }, dark: { ...cached.dark } }
  }

  const primary: TonalPalette = { hue: seed.h, chroma: seed.c }
  const neutral: TonalPalette = { hue: seed.h, chroma: NEUTRAL_CHROMA }
  const neutralVariant: TonalPalette = { hue: seed.h, chroma: NEUTRAL_VARIANT_CHROMA }
  const error: TonalPalette = { hue: ERROR_HUE, chroma: ERROR_CHROMA }

  const light = buildRoles(primary, neutral, neutralVariant, error, false)
  const dark = buildRoles(primary, neutral, neutralVariant, error, true)

  if (paletteCache.size > 64) paletteCache.clear()
  paletteCache.set(seed.hex, { light, dark })

  return { seed: seed.hex, light: { ...light }, dark: { ...dark } }
}

/* ================================================================== *
 * 壁纸取色
 * ================================================================== */

interface Candidate {
  r: number
  g: number
  b: number
  weight: number
}

interface Bin {
  r: number
  g: number
  b: number
  n: number
}

function distanceSq(a: Candidate, b: Candidate): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return dr * dr + dg * dg + db * db
}

/** 确定性 k-means++ 初始化 + Lloyd 迭代（按权重加权） */
function kmeans(points: Candidate[], k: number, iterations: number): Candidate[] {
  if (points.length === 0) return []
  if (points.length <= k) return points.map((p) => ({ ...p }))

  // 第一个质心：权重最大的点
  let first = 0
  for (let i = 1; i < points.length; i++) {
    if (points[i].weight > points[first].weight) first = i
  }
  const centroids: Candidate[] = [{ ...points[first] }]

  // 后续质心：取 weight * distance^2 最大的点（确定性 k-means++）
  const best = points.map((p) => distanceSq(p, centroids[0]))
  while (centroids.length < k) {
    let pick = -1
    let pickValue = 0
    for (let i = 0; i < points.length; i++) {
      const value = best[i] * points[i].weight
      if (value > pickValue) {
        pickValue = value
        pick = i
      }
    }
    if (pick < 0) break
    const added = { ...points[pick] }
    centroids.push(added)
    for (let i = 0; i < points.length; i++) {
      const d = distanceSq(points[i], added)
      if (d < best[i]) best[i] = d
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, w: 0 }))
    for (const p of points) {
      let index = 0
      let minDist = Infinity
      for (let j = 0; j < centroids.length; j++) {
        const d = distanceSq(p, centroids[j])
        if (d < minDist) {
          minDist = d
          index = j
        }
      }
      const s = sums[index]
      s.r += p.r * p.weight
      s.g += p.g * p.weight
      s.b += p.b * p.weight
      s.w += p.weight
    }
    for (let j = 0; j < centroids.length; j++) {
      const s = sums[j]
      if (s.w > 0) {
        centroids[j] = { r: s.r / s.w, g: s.g / s.w, b: s.b / s.w, weight: s.w }
      }
    }
  }

  return centroids
}

/** 候选打分：鲜艳度（HCT chroma）优先，按出现频率加权，并避开过暗过亮 */
function scoreCandidate(candidate: Candidate, totalWeight: number): number {
  const rgb = {
    r: clampInt(0, 255, candidate.r),
    g: clampInt(0, 255, candidate.g),
    b: clampInt(0, 255, candidate.b)
  }
  const hct = rgbToHct(rgb)
  if (!Number.isFinite(hct.c) || hct.c < PICK_MIN_CHROMA) return -1
  if (hct.t < PICK_MIN_TONE || hct.t > PICK_MAX_TONE) return -1

  const population = totalWeight > 0 ? clamp(0, 1, candidate.weight / totalWeight) : 0
  const populationFactor = Math.pow(population, 0.25)
  const toneFactor = clamp(0.1, 1, 1 - Math.abs(hct.t - 60) / 70)
  return hct.c * populationFactor * toneFactor
}

/**
 * 从 BGRA 像素缓冲区里挑一个适合做种子的颜色。
 * 输入是 Electron `nativeImage.toBitmap()` 的原始格式：BGRA，每像素 4 字节，行优先。
 *
 * 流程：降采样 -> 5bit/通道直方图 -> 高频色 k-means 收敛 -> 鲜艳度打分。
 * 找不到合适颜色（非法尺寸、缓冲区过短、全灰图等）时返回 null。
 */
export function pickSeedFromBitmap(
  bgra: Buffer | Uint8Array,
  width: number,
  height: number
): string | null {
  if (!bgra || typeof bgra.length !== 'number') return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null

  const w = Math.floor(width)
  const h = Math.floor(height)
  if (w <= 0 || h <= 0) return null

  const required = w * h * 4
  if (!Number.isFinite(required) || bgra.length < required) return null

  // 1. 降采样（大图也能快速处理）
  const maxSamples = 24000
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / maxSamples)))

  const bins = new Map<number, Bin>()
  let sampled = 0
  for (let y = 0; y < h; y += stride) {
    const rowStart = y * w * 4
    for (let x = 0; x < w; x += stride) {
      const i = rowStart + x * 4
      const b = bgra[i]
      const g = bgra[i + 1]
      const r = bgra[i + 2]
      const a = bgra[i + 3]
      if (a < 8) continue // 跳过近乎全透明的像素
      sampled++
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const bin = bins.get(key)
      if (bin) {
        bin.r += r
        bin.g += g
        bin.b += b
        bin.n++
      } else {
        bins.set(key, { r, g, b, n: 1 })
      }
    }
  }
  if (sampled === 0 || bins.size === 0) return null

  // 2. 高频色
  const all: Candidate[] = []
  for (const bin of bins.values()) {
    all.push({ r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n, weight: bin.n })
  }
  all.sort((a, b) => b.weight - a.weight)
  const top = all.slice(0, 24)

  // 3. k-means 收敛
  const clusters = kmeans(top, Math.min(8, top.length), 12)

  // 4. 打分：直方图高频色与聚类中心一起参与，避免聚类把小块鲜艳色吞掉
  let bestScore = 0
  let bestCandidate: Candidate | null = null
  for (const candidate of top.concat(clusters)) {
    const score = scoreCandidate(candidate, sampled)
    if (score > bestScore) {
      bestScore = score
      bestCandidate = candidate
    }
  }
  if (!bestCandidate || bestScore <= 0) return null

  return rgbToHex({
    r: clampInt(0, 255, bestCandidate.r),
    g: clampInt(0, 255, bestCandidate.g),
    b: clampInt(0, 255, bestCandidate.b)
  })
}
