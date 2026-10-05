/**
 * index.ts —— APK 解析引擎入口（零依赖）
 *
 * 只使用 Node 内置模块（node:fs / node:path / node:buffer / node:zlib），
 * 不依赖 aapt / aapt2 / Android SDK，直接从 .apk 解析安装决策所需信息。
 *
 * 对外契约：
 *   export async function parseApk(filePath: string): Promise<ApkInfo>
 *   parseApk 永不 reject —— 任何异常都会写入 parseError 并返回填充好的 ApkInfo。
 *
 * 图标解析策略（按优先级，全部失败则 iconDataUrl = null）：
 *   1. application@icon / roundIcon 资源引用 → 所有 config 候选：
 *      位图（png/jpg/webp，高密度优先）直接读取；
 *   2. 候选是 drawable XML → 递归解析 adaptive-icon / layer-list / vector /
 *      shape / bitmap / inset / selector；
 *   3. 纯颜色 drawable → 生成纯色 PNG；
 *   4. 直接扫描 zip 里 res/mipmap-<density>/ic_launcher.(png|webp) 等常见路径；
 *   5. res/mipmap-<density>/ 下密度最高的位图兜底。
 *
 * 注意：很多现代 APK（例如 Magisk）的启动图标是**纯矢量**的（VectorDrawable），
 * 包里根本没有位图图标。为了让 UI 一定有图标可显示，本文件内置了一个
 * 零依赖的 VectorDrawable 软件光栅化器（SVG pathData → 扫描线填充 → PNG 编码）。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

import type { ApkInfo } from '../../shared/types'
import { ZipReader } from './zip'
import {
  attrRefId,
  findElement,
  getAttr,
  nodeNumber,
  nodeRefId,
  nodeString,
  parseAxml,
  summarizeManifest,
  type AxmlNode,
  type AxmlValue,
  type ManifestSummary
} from './axml'
import { ArscTable } from './arsc'

/* --------------------------------- 常量 --------------------------------- */

/** 图标文件大小上限：超过则跳过该候选 */
const MAX_ICON_BYTES = 512 * 1024

/** 矢量图标光栅化后的边长（正方形） */
const ICON_SIZE = 192

/** 图标解析递归深度上限（每一层 drawable 元素算一层） */
const MAX_DRAWABLE_DEPTH = 6

/** ABI 规范化排序（未知 ABI 排最后） */
const ABI_ORDER = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'mips64', 'mips']

const MANIFEST_ENTRY = 'AndroidManifest.xml'
const ARSC_ENTRY = 'resources.arsc'

/** 密度目录优先级（从高到低） */
const DENSITY_SUFFIXES = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'ldpi', 'nodpi', '']
const DENSITY_RANK: Readonly<Record<string, number>> = {
  xxxhdpi: 640,
  xxhdpi: 480,
  xhdpi: 320,
  hdpi: 240,
  tvdpi: 213,
  mdpi: 160,
  ldpi: 120,
  nodpi: 0
}

const ICON_BASE_NAMES = [
  'ic_launcher',
  'ic_launcher_round',
  'app_icon',
  'ic_launcher_foreground',
  'launcher_icon',
  'icon'
]
const ICON_DIRS = ['res/mipmap', 'res/drawable']
const ICON_EXTS = ['.png', '.webp', '.jpg', '.jpeg']

/* ------------------------------- 小工具函数 ------------------------------ */

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function abiRank(abi: string): number {
  const i = ABI_ORDER.indexOf(abi)
  return i >= 0 ? i : ABI_ORDER.length
}

function sortAbis(abis: Iterable<string>): string[] {
  return [...abis].sort((a, b) => {
    const ra = abiRank(a)
    const rb = abiRank(b)
    if (ra !== rb) return ra - rb
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** 按文件头判断图片 MIME，不伪造类型 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    buf.length >= 6 &&
    (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif'
  }
  return null
}

function isImagePath(p: string): boolean {
  const l = p.toLowerCase()
  return l.endsWith('.png') || l.endsWith('.webp') || l.endsWith('.jpg') || l.endsWith('.jpeg')
}

/* =========================================================================
 * 第 1 部分：位图图标读取
 * ========================================================================= */

async function readIconFromZip(zip: ZipReader, entryPath: string): Promise<string | null> {
  const name = entryPath.replace(/^\/+/, '').replace(/\\/g, '/')
  if (!name || !isImagePath(name)) return null
  let buf: Buffer | null = null
  try {
    buf = await zip.readEntry(name)
  } catch {
    return null
  }
  if (!buf || buf.length === 0) return null
  if (buf.length > MAX_ICON_BYTES) return null
  const mime = sniffImageMime(buf)
  if (!mime) return null
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* =========================================================================
 * 第 2 部分：零依赖 PNG 编码
 * ========================================================================= */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] as number) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** RGBA8 → PNG（filter 0，zlib deflate） */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* =========================================================================
 * 第 3 部分：RGBA 画布 + 扫描线多边形填充
 * ========================================================================= */

/** 非预乘 RGBA 浮点画布（0..1） */
interface Canvas {
  size: number
  r: Float32Array
  g: Float32Array
  b: Float32Array
  a: Float32Array
}

function createCanvas(size: number): Canvas {
  const n = size * size
  return {
    size,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    a: new Float32Array(n)
  }
}

/** src（非预乘）覆盖到 dst 上 */
function blendPixel(
  dst: Canvas,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number
): void {
  if (sa <= 0) return
  const da = dst.a[i]
  const oa = sa + da * (1 - sa)
  if (oa <= 0) {
    dst.a[i] = 0
    return
  }
  const w = da * (1 - sa)
  dst.r[i] = (sr * sa + dst.r[i] * w) / oa
  dst.g[i] = (sg * sa + dst.g[i] * w) / oa
  dst.b[i] = (sb * sa + dst.b[i] * w) / oa
  dst.a[i] = oa
}

/** 用覆盖率图把纯色覆盖到画布 */
function compositeCoverage(cv: Canvas, cov: Float32Array, argb: number, alpha: number): void {
  const cr = ((argb >>> 16) & 0xff) / 255
  const cg = ((argb >>> 8) & 0xff) / 255
  const cb = (argb & 0xff) / 255
  const n = cv.size * cv.size
  for (let i = 0; i < n; i++) {
    let a = cov[i]
    if (a <= 0) continue
    if (a > 1) a = 1
    a *= alpha
    if (a <= 0) continue
    blendPixel(cv, i, cr, cg, cb, a)
  }
}

/** 整块填色 */
function fillSolid(cv: Canvas, argb: number): void {
  const n = cv.size * cv.size
  const cr = ((argb >>> 16) & 0xff) / 255
  const cg = ((argb >>> 8) & 0xff) / 255
  const cb = (argb & 0xff) / 255
  const ca = ((argb >>> 24) & 0xff) / 255
  for (let i = 0; i < n; i++) blendPixel(cv, i, cr, cg, cb, ca)
}

/** over 画布叠加到 base 画布（同尺寸） */
function compositeCanvas(base: Canvas, over: Canvas): void {
  const n = Math.min(base.size * base.size, over.size * over.size)
  for (let i = 0; i < n; i++) {
    blendPixel(base, i, over.r[i], over.g[i], over.b[i], over.a[i])
  }
}

function canvasToRgba(cv: Canvas): Buffer {
  const n = cv.size * cv.size
  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(clamp01(cv.r[i]) * 255)
    out[i * 4 + 1] = Math.round(clamp01(cv.g[i]) * 255)
    out[i * 4 + 2] = Math.round(clamp01(cv.b[i]) * 255)
    out[i * 4 + 3] = Math.round(clamp01(cv.a[i]) * 255)
  }
  return out
}

/** 垂直子采样数（抗锯齿） */
const SUB_SAMPLES = 4

function addSpan(
  cov: Float32Array,
  size: number,
  row: number,
  x0: number,
  x1: number,
  weight: number
): void {
  if (x1 <= x0) return
  let i0 = Math.floor(x0)
  let i1 = Math.floor(x1 - 1e-9)
  if (i0 < 0) i0 = 0
  if (i1 > size - 1) i1 = size - 1
  const base = row * size
  for (let px = i0; px <= i1; px++) {
    const l = x0 > px ? x0 : px
    const r = x1 < px + 1 ? x1 : px + 1
    if (r > l) cov[base + px] += (r - l) * weight
  }
}

/**
 * 扫描线填充：多边形（扁平 [x,y,x,y,...] 数组）→ 覆盖率图。
 * 每个像素行做 SUB_SAMPLES 次水平采样，水平方向按跨度精确积分。
 */
function fillPolygons(
  polys: number[][],
  size: number,
  evenOdd: boolean,
  cov: Float32Array
): void {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of polys) {
    for (let i = 1; i < p.length; i += 2) {
      const y = p[i]
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return
  const rowStart = Math.max(0, Math.floor(minY))
  const rowEnd = Math.min(size - 1, Math.ceil(maxY))
  if (rowEnd < rowStart) return

  const weight = 1 / SUB_SAMPLES
  const hits: { x: number; d: number }[] = []
  for (let py = rowStart; py <= rowEnd; py++) {
    for (let sy = 0; sy < SUB_SAMPLES; sy++) {
      const y = py + (sy + 0.5) * weight
      hits.length = 0
      for (const p of polys) {
        const n = p.length
        if (n < 6) continue
        let ax = p[n - 2]
        let ay = p[n - 1]
        for (let i = 0; i < n; i += 2) {
          const bx = p[i]
          const by = p[i + 1]
          if (ay !== by && ay <= y !== by <= y) {
            hits.push({ x: ax + ((y - ay) / (by - ay)) * (bx - ax), d: by > ay ? 1 : -1 })
          }
          ax = bx
          ay = by
        }
      }
      if (hits.length < 2) continue
      hits.sort((p, q) => p.x - q.x)
      if (evenOdd) {
        for (let k = 0; k + 1 < hits.length; k += 2) {
          addSpan(cov, size, py, hits[k].x, hits[k + 1].x, weight)
        }
      } else {
        let wind = 0
        let start = 0
        for (const h of hits) {
          const prev = wind
          wind += h.d
          if (prev === 0 && wind !== 0) start = h.x
          else if (prev !== 0 && wind === 0) addSpan(cov, size, py, start, h.x, weight)
        }
      }
    }
  }
}

/* =========================================================================
 * 第 4 部分：SVG pathData 解析 + 曲线离散化
 * ========================================================================= */

const PATH_ARGC: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0
}

function tokenizePathData(d: string): Array<string | number> {
  const out: Array<string | number> = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d)) !== null) {
    if (m[1] !== undefined) out.push(m[1])
    else if (m[2] !== undefined) out.push(Number(m[2]))
  }
  return out
}

function cubicTo(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
  y: number
): void {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2)
  const n = Math.max(4, Math.min(24, Math.ceil(len / 6)))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const dd = t * t * t
    out.push(a * x0 + b * x1 + c * x2 + dd * x, a * y0 + b * y1 + c * y2 + dd * y)
  }
}

function quadTo(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x: number,
  y: number
): void {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x - x1, y - y1)
  const n = Math.max(3, Math.min(20, Math.ceil(len / 6)))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const mt = 1 - t
    out.push(mt * mt * x0 + 2 * mt * t * x1 + t * t * x, mt * mt * y0 + 2 * mt * t * y1 + t * t * y)
  }
}

/** SVG 椭圆弧 → 折线（W3C 实现说明中的端点参数化转中心参数化） */
function arcTo(
  out: number[],
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x1: number,
  y1: number
): void {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx < 1e-9 || ry < 1e-9 || (x0 === x1 && y0 === y1)) {
    out.push(x1, y1)
    return
  }
  const phi = (phiDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx2 = (x0 - x1) / 2
  const dy2 = (y0 - y1) / 2
  const x1p = cosPhi * dx2 + sinPhi * dy2
  const y1p = -sinPhi * dx2 + cosPhi * dy2
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, den === 0 ? 0 : num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const theta1 = ang(1, 0, ux, uy)
  let dTheta = ang(ux, uy, vx, vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI
  const steps = Math.max(6, Math.min(48, Math.ceil((Math.abs(dTheta) / Math.PI) * 24)))
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (dTheta * i) / steps
    const ct = Math.cos(t)
    const st = Math.sin(t)
    out.push(cx + rx * cosPhi * ct - ry * sinPhi * st, cy + rx * sinPhi * ct + ry * cosPhi * st)
  }
}

/** pathData → 子路径点集（扁平 [x,y,...]，坐标仍是 path 空间） */
function parsePathDataToSubPaths(d: string): number[][] {
  const toks = tokenizePathData(d)
  const subs: number[][] = []
  let cur: number[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let pcx = 0
  let pcy = 0
  let pqx = 0
  let pqy = 0
  let prevCmd = ''
  let cmd = ''
  let i = 0

  const finish = (): void => {
    if (cur.length >= 6) subs.push(cur)
    cur = []
  }

  while (i < toks.length) {
    const t = toks[i]
    if (typeof t === 'string') {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        if (cur.length >= 2) {
          cur.push(sx, sy)
          finish()
        }
        cx = sx
        cy = sy
        prevCmd = cmd
        continue
      }
    } else if (cmd === '') {
      break
    }
    const C = cmd.toUpperCase()
    const rel = cmd !== C
    const argc = PATH_ARGC[C]
    if (argc === undefined) {
      i++
      continue
    }
    if (i + argc > toks.length) break
    const a: number[] = []
    for (let k = 0; k < argc; k++) a.push(Number(toks[i + k]))
    i += argc
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0

    switch (C) {
      case 'M': {
        const x = a[0] + ox
        const y = a[1] + oy
        finish()
        cur.push(x, y)
        cx = x
        cy = y
        sx = x
        sy = y
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
        cur.push(a[0] + ox, a[1] + oy)
        cx = a[0] + ox
        cy = a[1] + oy
        break
      case 'H':
        cur.push(a[0] + ox, cy)
        cx = a[0] + ox
        break
      case 'V':
        cur.push(cx, a[0] + oy)
        cy = a[0] + oy
        break
      case 'C': {
        const x1 = a[0] + ox
        const y1 = a[1] + oy
        const x2 = a[2] + ox
        const y2 = a[3] + oy
        const x = a[4] + ox
        const y = a[5] + oy
        cubicTo(cur, cx, cy, x1, y1, x2, y2, x, y)
        pcx = x2
        pcy = y2
        cx = x
        cy = y
        break
      }
      case 'S': {
        const x2 = a[0] + ox
        const y2 = a[1] + oy
        const x = a[2] + ox
        const y = a[3] + oy
        const smooth = prevCmd === 'C' || prevCmd === 'c' || prevCmd === 'S' || prevCmd === 's'
        const x1 = smooth ? 2 * cx - pcx : cx
        const y1 = smooth ? 2 * cy - pcy : cy
        cubicTo(cur, cx, cy, x1, y1, x2, y2, x, y)
        pcx = x2
        pcy = y2
        cx = x
        cy = y
        break
      }
      case 'Q': {
        const x1 = a[0] + ox
        const y1 = a[1] + oy
        const x = a[2] + ox
        const y = a[3] + oy
        quadTo(cur, cx, cy, x1, y1, x, y)
        pqx = x1
        pqy = y1
        cx = x
        cy = y
        break
      }
      case 'T': {
        const x = a[0] + ox
        const y = a[1] + oy
        const smooth = prevCmd === 'Q' || prevCmd === 'q' || prevCmd === 'T' || prevCmd === 't'
        const x1 = smooth ? 2 * cx - pqx : cx
        const y1 = smooth ? 2 * cy - pqy : cy
        quadTo(cur, cx, cy, x1, y1, x, y)
        pqx = x1
        pqy = y1
        cx = x
        cy = y
        break
      }
      case 'A': {
        const x = a[5] + ox
        const y = a[6] + oy
        arcTo(cur, cx, cy, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, x, y)
        cx = x
        cy = y
        break
      }
      default:
        break
    }
    prevCmd = C
  }
  finish()
  return subs
}

/* =========================================================================
 * 第 5 部分：仿射变换
 * ========================================================================= */

/** [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f */
type Mat = [number, number, number, number, number, number]

/** 先应用 n，再应用 m */
function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

function transformPolys(polys: number[][], m: Mat): number[][] {
  const [a, b, c, d, e, f] = m
  const out: number[][] = []
  for (const p of polys) {
    const q = new Array<number>(p.length)
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i]
      const y = p[i + 1]
      q[i] = a * x + c * y + e
      q[i + 1] = b * x + d * y + f
    }
    out.push(q)
  }
  return out
}

/** <group> 的本地矩阵（与 Android VGroup.updateLocalMatrix 一致） */
function groupMatrix(node: AxmlNode): Mat {
  const tx = nodeNumber(node, 'translateX') ?? 0
  const ty = nodeNumber(node, 'translateY') ?? 0
  const sx = nodeNumber(node, 'scaleX') ?? 1
  const sy = nodeNumber(node, 'scaleY') ?? 1
  const rot = nodeNumber(node, 'rotation') ?? 0
  const px = nodeNumber(node, 'pivotX') ?? 0
  const py = nodeNumber(node, 'pivotY') ?? 0
  const rad = (rot * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let m: Mat = [1, 0, 0, 1, -px, -py]
  m = matMul([sx, 0, 0, sy, 0, 0], m)
  m = matMul([cos, sin, -sin, cos, 0, 0], m)
  m = matMul([1, 0, 0, 1, px + tx, py + ty], m)
  return m
}

/* =========================================================================
 * 第 6 部分：VectorDrawable 渲染
 * ========================================================================= */

/** 颜色值 → ARGB 整数（支持字面量、#RRGGBB 字符串、@color 引用） */
function resolveColor(v: AxmlValue | undefined, arsc: ArscTable | null): number | null {
  if (!v) return null
  if (v.kind === 'int') return v.value >>> 0
  if (v.kind === 'reference' || v.kind === 'attribute') {
    if (!arsc) return null
    return arsc.getColor(v.id) ?? arsc.getInt(v.id)
  }
  if (v.kind === 'string') {
    const t = v.value.trim()
    const m = /^#([0-9a-fA-F]{3,8})$/.exec(t)
    if (!m) return null
    const h = m[1]
    if (h.length === 3) {
      const r = Number.parseInt(h[0] + h[0], 16)
      const g = Number.parseInt(h[1] + h[1], 16)
      const b = Number.parseInt(h[2] + h[2], 16)
      return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0
    }
    if (h.length === 4) {
      const a = Number.parseInt(h[0] + h[0], 16)
      const r = Number.parseInt(h[1] + h[1], 16)
      const g = Number.parseInt(h[2] + h[2], 16)
      const b = Number.parseInt(h[3] + h[3], 16)
      return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
    }
    if (h.length === 6) return (0xff000000 | Number.parseInt(h, 16)) >>> 0
    if (h.length === 8) return Number.parseInt(h, 16) >>> 0
    return null
  }
  return null
}

/** 把折线扩成描边四边形（近似，无圆角接头） */
function strokeQuads(polys: number[][], width: number): number[][] {
  const hw = Math.max(width, 0.7) / 2
  const out: number[][] = []
  for (const p of polys) {
    const n = p.length
    if (n < 4) continue
    const seg = (x0: number, y0: number, x1: number, y1: number): void => {
      let dx = x1 - x0
      let dy = y1 - y0
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) return
      dx /= len
      dy /= len
      const nx = -dy * hw
      const ny = dx * hw
      out.push([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny])
    }
    for (let i = 0; i + 3 < n; i += 2) seg(p[i], p[i + 1], p[i + 2], p[i + 3])
    seg(p[n - 2], p[n - 1], p[0], p[1])
  }
  return out
}

function renderVectorPath(
  cv: Canvas,
  node: AxmlNode,
  mat: Mat,
  scale: number,
  arsc: ArscTable | null
): void {
  const d = nodeString(node, 'pathData')
  if (!d) return
  let polys: number[][]
  try {
    polys = transformPolys(parsePathDataToSubPaths(d), mat)
  } catch {
    return
  }
  if (polys.length === 0) return

  const fillColor = resolveColor(getAttr(node, 'fillColor'), arsc)
  if (fillColor !== null) {
    const fillAlpha = clamp01(nodeNumber(node, 'fillAlpha') ?? 1)
    const evenOdd = (nodeNumber(node, 'fillType') ?? 0) === 1
    if (fillAlpha > 0) {
      const cov = new Float32Array(cv.size * cv.size)
      fillPolygons(polys, cv.size, evenOdd, cov)
      compositeCoverage(cv, cov, fillColor, fillAlpha)
    }
  }

  const strokeColor = resolveColor(getAttr(node, 'strokeColor'), arsc)
  if (strokeColor !== null) {
    const sw = (nodeNumber(node, 'strokeWidth') ?? 0) * scale
    const strokeAlpha = clamp01(nodeNumber(node, 'strokeAlpha') ?? 1)
    if (sw > 0.05 && strokeAlpha > 0) {
      const cov = new Float32Array(cv.size * cv.size)
      fillPolygons(strokeQuads(polys, sw), cv.size, false, cov)
      compositeCoverage(cv, cov, strokeColor, strokeAlpha)
    }
  }
}

function renderVectorGroup(
  cv: Canvas,
  node: AxmlNode,
  mat: Mat,
  scale: number,
  arsc: ArscTable | null,
  depth: number
): void {
  if (depth > 8) return
  for (const child of node.children) {
    if (child.name === 'path') renderVectorPath(cv, child, mat, scale, arsc)
    else if (child.name === 'group') {
      renderVectorGroup(cv, child, matMul(mat, groupMatrix(child)), scale, arsc, depth + 1)
    }
  }
}

/** <vector> → 画布 */
function renderVector(node: AxmlNode, arsc: ArscTable | null): Canvas {
  const cv = createCanvas(ICON_SIZE)
  const vw = nodeNumber(node, 'viewportWidth') ?? ICON_SIZE
  const vh = nodeNumber(node, 'viewportHeight') ?? ICON_SIZE
  if (!(vw > 0) || !(vh > 0)) return cv
  const s = ICON_SIZE / Math.max(vw, vh)
  const tx = (ICON_SIZE - vw * s) / 2
  const ty = (ICON_SIZE - vh * s) / 2
  renderVectorGroup(cv, node, [s, 0, 0, s, tx, ty], s, arsc, 0)
  return cv
}

/* ------------------------------- <shape> ------------------------------- */

function ellipsePoly(cx: number, cy: number, rx: number, ry: number, steps = 64): number[] {
  const out: number[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
  }
  return out
}

function reversePoly(p: number[]): number[] {
  const out: number[] = []
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1])
  return out
}

/** <shape> → 画布（支持 rectangle / oval / ring + <solid>） */
function renderShape(node: AxmlNode, arsc: ArscTable | null): Canvas {
  const cv = createCanvas(ICON_SIZE)
  const S = ICON_SIZE
  const kind = nodeNumber(node, 'shape') ?? 0 // 0 rect, 1 oval, 2 line, 3 ring
  const solid = findElement(node, 'solid')
  let color = solid ? resolveColor(getAttr(solid, 'color'), arsc) : null
  if (color === null) {
    const grad = findElement(node, 'gradient')
    if (grad) {
      color =
        resolveColor(getAttr(grad, 'startColor'), arsc) ??
        resolveColor(getAttr(grad, 'centerColor'), arsc) ??
        resolveColor(getAttr(grad, 'endColor'), arsc)
    }
  }
  if (color === null) return cv

  const polys: number[][] = []
  if (kind === 1) {
    polys.push(ellipsePoly(S / 2, S / 2, S / 2, S / 2))
  } else if (kind === 3) {
    const thickness = nodeNumber(node, 'thickness') ?? S * 0.1
    const inner = Math.max(1, S / 2 - Math.max(1, thickness))
    polys.push(ellipsePoly(S / 2, S / 2, S / 2, S / 2))
    polys.push(reversePoly(ellipsePoly(S / 2, S / 2, inner, inner)))
  } else if (kind === 2) {
    return cv
  } else {
    polys.push([0, 0, S, 0, S, S, 0, S])
  }
  const cov = new Float32Array(S * S)
  fillPolygons(polys, S, false, cov)
  compositeCoverage(cv, cov, color, 1)
  return cv
}

/* =========================================================================
 * 第 7 部分：drawable XML 递归解析
 * ========================================================================= */

type IconSource = { kind: 'raster'; dataUrl: string } | { kind: 'canvas'; canvas: Canvas }

function iconSourceToDataUrl(src: IconSource): string | null {
  if (src.kind === 'raster') return src.dataUrl
  const png = encodePng(src.canvas.size, src.canvas.size, canvasToRgba(src.canvas))
  if (png.length > MAX_ICON_BYTES) return null
  return `data:image/png;base64,${png.toString('base64')}`
}

/** 资源 id → 图标（位图直读 / XML 递归 / 纯色） */
async function loadDrawableById(
  zip: ZipReader,
  arsc: ArscTable | null,
  id: number,
  depth: number
): Promise<IconSource | null> {
  if (!arsc || id === 0 || depth > MAX_DRAWABLE_DEPTH) return null
  let candidates: string[] = []
  try {
    candidates = arsc.getStringCandidates(id)
  } catch {
    return null
  }
  const xmls: string[] = []
  for (const c of candidates) {
    if (isImagePath(c)) {
      const dataUrl = await readIconFromZip(zip, c)
      if (dataUrl) return { kind: 'raster', dataUrl }
    } else if (c.toLowerCase().endsWith('.xml')) {
      xmls.push(c)
    }
  }
  for (const x of xmls) {
    const src = await loadDrawablePath(zip, arsc, x, depth + 1)
    if (src) return src
  }
  // 纯颜色 drawable（@color/xxx 也可以直接当 drawable 用）
  const color = arsc.getColor(id)
  if (color !== null && (color >>> 24) !== 0) {
    const cv = createCanvas(ICON_SIZE)
    fillSolid(cv, color)
    return { kind: 'canvas', canvas: cv }
  }
  return null
}

/** APK 内路径 → 图标 */
async function loadDrawablePath(
  zip: ZipReader,
  arsc: ArscTable | null,
  entryPath: string,
  depth: number
): Promise<IconSource | null> {
  if (depth > MAX_DRAWABLE_DEPTH) return null
  let buf: Buffer | null = null
  try {
    buf = await zip.readEntry(entryPath)
  } catch {
    buf = null
  }
  if (!buf) return null
  let root: AxmlNode
  try {
    root = parseAxml(buf)
  } catch {
    return null
  }
  return renderDrawableNode(zip, arsc, root, depth)
}

/** 从元素上取 drawable 引用并递归 */
async function loadDrawableFromElement(
  zip: ZipReader,
  arsc: ArscTable | null,
  el: AxmlNode,
  depth: number
): Promise<IconSource | null> {
  if (depth > MAX_DRAWABLE_DEPTH) return null
  const ref = nodeRefId(el, 'drawable') ?? nodeRefId(el, 'src')
  if (ref !== null && ref !== 0) {
    const src = await loadDrawableById(zip, arsc, ref, depth)
    if (src) return src
  }
  for (const child of el.children) {
    const src = await renderDrawableNode(zip, arsc, child, depth + 1)
    if (src) return src
  }
  return null
}

async function renderDrawableNode(
  zip: ZipReader,
  arsc: ArscTable | null,
  node: AxmlNode,
  depth: number
): Promise<IconSource | null> {
  if (depth > MAX_DRAWABLE_DEPTH) return null
  switch (node.name) {
    case 'vector':
      return { kind: 'canvas', canvas: renderVector(node, arsc) }

    case 'shape':
      return { kind: 'canvas', canvas: renderShape(node, arsc) }

    case 'layer-list': {
      const base = createCanvas(ICON_SIZE)
      let painted = false
      let firstRaster: string | null = null
      for (const item of node.children) {
        let src: IconSource | null = null
        if (item.name === 'item') {
          src = await loadDrawableFromElement(zip, arsc, item, depth + 1)
        } else {
          src = await renderDrawableNode(zip, arsc, item, depth + 1)
        }
        if (!src) continue
        if (src.kind === 'raster') {
          if (!firstRaster) firstRaster = src.dataUrl
          continue
        }
        compositeCanvas(base, src.canvas)
        painted = true
      }
      if (painted) return { kind: 'canvas', canvas: base }
      return firstRaster ? { kind: 'raster', dataUrl: firstRaster } : null
    }

    case 'adaptive-icon': {
      const layers: IconSource[] = []
      for (const tag of ['background', 'foreground']) {
        const el = findElement(node, tag)
        if (!el) continue
        const src = await loadDrawableFromElement(zip, arsc, el, depth + 1)
        if (src) layers.push(src)
      }
      if (layers.length === 0) return null
      const canvases = layers.filter((l): l is { kind: 'canvas'; canvas: Canvas } => l.kind === 'canvas')
      if (canvases.length > 0) {
        const base = createCanvas(ICON_SIZE)
        for (const l of layers) if (l.kind === 'canvas') compositeCanvas(base, l.canvas)
        return { kind: 'canvas', canvas: base }
      }
      // 全是位图：foreground（后出现）更有辨识度
      const last = layers[layers.length - 1]
      return last.kind === 'raster' ? last : null
    }

    case 'bitmap':
      return loadDrawableFromElement(zip, arsc, node, depth + 1)

    case 'inset':
    case 'clip-path':
    case 'scale':
    case 'rotate':
      return loadDrawableFromElement(zip, arsc, node, depth + 1)

    case 'selector':
    case 'ripple':
    case 'animated-selector':
    case 'animated-vector':
    case 'transition':
      return loadDrawableFromElement(zip, arsc, node, depth + 1)

    default: {
      const ref = nodeRefId(node, 'drawable') ?? nodeRefId(node, 'src')
      if (ref !== null && ref !== 0) return loadDrawableById(zip, arsc, ref, depth + 1)
      return null
    }
  }
}

/* =========================================================================
 * 第 8 部分：图标解析总入口
 * ========================================================================= */

/** 解析 application@icon 的值 */
async function resolveIconValue(
  zip: ZipReader,
  arsc: ArscTable | null,
  value: AxmlValue | undefined,
  depth: number
): Promise<string | null> {
  if (!value || depth > MAX_DRAWABLE_DEPTH) return null
  if (value.kind === 'string') {
    const dataUrl = await readIconFromZip(zip, value.value)
    if (dataUrl) return dataUrl
    if (value.value.toLowerCase().endsWith('.xml')) {
      const src = await loadDrawablePath(zip, arsc, value.value, depth + 1)
      return src ? iconSourceToDataUrl(src) : null
    }
    return null
  }
  const id = attrRefId(value)
  if (id === null || id === 0) return null
  const src = await loadDrawableById(zip, arsc, id, depth)
  return src ? iconSourceToDataUrl(src) : null
}

/** 密度目录 → 排序权重 */
function densityWeight(dirName: string): number {
  const m = /^(?:mipmap|drawable)-([a-z]+)(?:-|$)/i.exec(dirName)
  const key = m ? m[1].toLowerCase() : ''
  return DENSITY_RANK[key] ?? 1
}

/** 兜底：直接扫描 zip 里常见的启动图标路径 */
async function scanForLauncherIcon(zip: ZipReader, arsc: ArscTable | null): Promise<string | null> {
  // 1) 常见命名 + 密度后缀
  for (const base of ICON_BASE_NAMES) {
    for (const dens of DENSITY_SUFFIXES) {
      for (const dir of ICON_DIRS) {
        for (const ext of ICON_EXTS) {
          const p = dens ? `${dir}-${dens}/${base}${ext}` : `${dir}/${base}${ext}`
          if (!zip.has(p)) continue
          const dataUrl = await readIconFromZip(zip, p)
          if (dataUrl) return dataUrl
        }
      }
    }
  }

  // 2) anydpi-v26 自适应图标 XML（位图被 aapt2 剥掉时只剩 XML）
  for (const base of ICON_BASE_NAMES) {
    for (const dens of ['anydpi-v26', 'anydpi']) {
      for (const dir of ICON_DIRS) {
        const p = `${dir}-${dens}/${base}.xml`
        if (!zip.has(p)) continue
        const src = await loadDrawablePath(zip, arsc, p, 1)
        const dataUrl = src ? iconSourceToDataUrl(src) : null
        if (dataUrl) return dataUrl
      }
    }
  }

  // 3) 最后兜底：res/mipmap-*/ 下密度最高的位图（排除明显不是图标的）
  const junk = /(background|splash|banner|notification|shadow|screenshot|preview|thumb)/i
  const rasters = zip
    .listEntries()
    .filter((e) => {
      if (e.isDirectory) return false
      if (!/^res\/mipmap-[^/]+\/[^/]+\.(png|webp|jpg|jpeg)$/i.test(e.fileName)) return false
      return !junk.test(e.fileName)
    })
    .sort((a, b) => {
      const da = densityWeight(a.fileName.split('/')[1] ?? '')
      const db = densityWeight(b.fileName.split('/')[1] ?? '')
      if (da !== db) return db - da
      return b.uncompressedSize - a.uncompressedSize
    })

  for (const e of rasters.slice(0, 6)) {
    const dataUrl = await readIconFromZip(zip, e.fileName)
    if (dataUrl) return dataUrl
  }
  return null
}

async function resolveAppIcon(
  zip: ZipReader,
  arsc: ArscTable | null,
  summary: ManifestSummary
): Promise<string | null> {
  for (const v of [summary.appIcon ?? undefined, summary.roundIcon ?? undefined]) {
    const dataUrl = await resolveIconValue(zip, arsc, v, 0)
    if (dataUrl) return dataUrl
  }
  return scanForLauncherIcon(zip, arsc)
}

/* ------------------------------- 主入口 ------------------------------- */

/** 解析结果的扩展信息（不进 ApkInfo 契约，供安装后启动等场景使用） */
export interface ApkParseDetails {
  info: ApkInfo
  /** LAUNCHER 主 Activity 的 android:name（未补全包名） */
  launchableActivity: string | null
  /** 资源表解析出的包名（调试用） */
  resourcePackages: string[]
  /** 解析过程中产生的非致命告警 */
  warnings: string[]
}

/**
 * 解析 APK，返回 ApkInfo。
 * **永不 reject**：文件不存在/不可读时返回 fileSize=0 且 parseError 已填充的对象。
 */
export async function parseApk(filePath: string): Promise<ApkInfo> {
  const details = await parseApkDetailed(filePath)
  return details.info
}

/** 带扩展信息的解析入口 */
export async function parseApkDetailed(filePath: string): Promise<ApkParseDetails> {
  const parsedAt = Date.now()
  const fileName = path.basename(filePath)
  const info: ApkInfo = {
    filePath,
    fileName,
    fileSize: 0,
    packageName: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    targetSdk: null,
    compileSdk: null,
    appLabel: null,
    iconDataUrl: null,
    nativeAbis: [],
    hasNativeLibs: false,
    debuggable: false,
    testOnly: false,
    isSplit: false,
    permissions: [],
    parseError: null,
    parsedAt
  }
  const warnings: string[] = []
  let launchableActivity: string | null = null
  let resourcePackages: string[] = []

  /* ---------------------------- 1. 文件基本属性 ---------------------------- */
  try {
    const st = await fsp.stat(filePath)
    info.fileSize = st.size
    if (!st.isFile()) throw new Error('路径不是普通文件')
  } catch (err) {
    info.parseError = `无法读取文件：${errText(err)}`
    return { info, launchableActivity, resourcePackages, warnings }
  }

  /* ------------------------------ 2. 打开 ZIP ------------------------------ */
  let zip: ZipReader
  try {
    zip = await ZipReader.open(filePath)
  } catch (err) {
    info.parseError = `ZIP 解析失败：${errText(err)}`
    return { info, launchableActivity, resourcePackages, warnings }
  }

  try {
    const entries = zip.listEntries()

    /* ------------------------- 3. native ABI 扫描 ------------------------- */
    try {
      const abis = new Set<string>()
      for (const e of entries) {
        if (e.isDirectory) continue
        const parts = e.fileName.split('/')
        if (parts.length !== 3) continue
        if (parts[0] !== 'lib') continue
        if (!parts[2].endsWith('.so')) continue
        if (parts[1]) abis.add(parts[1])
      }
      info.nativeAbis = sortAbis(abis)
      info.hasNativeLibs = info.nativeAbis.length > 0
    } catch (err) {
      warnings.push(`native 库扫描失败：${errText(err)}`)
    }

    /* --------------------------- 4. resources.arsc -------------------------- */
    let arsc: ArscTable | null = null
    if (zip.has(ARSC_ENTRY)) {
      try {
        const arscBuf = await zip.readEntry(ARSC_ENTRY)
        if (arscBuf) {
          arsc = ArscTable.parse(arscBuf)
          if (!arsc) warnings.push('resources.arsc 解析失败，应用名/图标退化为兜底策略')
          else resourcePackages = arsc.listPackages().map((p) => `${p.name}(0x${p.id.toString(16)})`)
        }
      } catch (err) {
        warnings.push(`resources.arsc 读取失败：${errText(err)}`)
      }
    } else {
      warnings.push('APK 内没有 resources.arsc')
    }

    /* ------------------------ 5. AndroidManifest.xml ----------------------- */
    let summary: ManifestSummary | null = null
    try {
      const manifestBuf = await zip.readEntry(MANIFEST_ENTRY)
      if (!manifestBuf) throw new Error(`ZIP 内找不到 ${MANIFEST_ENTRY}`)
      const root = parseAxml(manifestBuf)
      summary = summarizeManifest(root)
      launchableActivity = summary.launchableActivity
    } catch (err) {
      info.parseError = `AndroidManifest.xml 解析失败：${errText(err)}`
    }

    if (summary) {
      info.packageName = summary.packageName
      info.versionName = summary.versionName
      info.debuggable = summary.debuggable
      info.testOnly = summary.testOnly
      info.permissions = summary.permissions
      info.isSplit = (summary.split !== null && summary.split !== '') || summary.isSplitRequired

      // versionCode / minSdk / targetSdk：数字取不到时尝试走资源引用
      info.versionCode =
        summary.versionCode ?? resolveIntRef(arsc, attrRefId(summary.versionCodeValue ?? undefined))
      info.minSdk =
        summary.minSdk ?? resolveIntRef(arsc, attrRefId(summary.minSdkValue ?? undefined))
      info.targetSdk =
        summary.targetSdk ?? resolveIntRef(arsc, attrRefId(summary.targetSdkValue ?? undefined))
      info.compileSdk = summary.compileSdk

      /* ------------------------------ 应用名 ------------------------------ */
      try {
        info.appLabel = resolveLabel(arsc, summary.appLabel)
      } catch (err) {
        warnings.push(`应用名解析失败：${errText(err)}`)
      }

      /* ------------------------------- 图标 ------------------------------- */
      try {
        info.iconDataUrl = await resolveAppIcon(zip, arsc, summary)
      } catch (err) {
        warnings.push(`图标解析失败：${errText(err)}`)
      }
    } else if (arsc) {
      try {
        info.iconDataUrl = await scanForLauncherIcon(zip, arsc)
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    const msg = `解析异常：${errText(err)}`
    info.parseError = info.parseError ? `${info.parseError}；${msg}` : msg
  } finally {
    await zip.close().catch(() => undefined)
  }

  return { info, launchableActivity, resourcePackages, warnings }
}

/* ------------------------------ 解析辅助 ------------------------------ */

/**
 * 少数 APK 会把 versionCode / minSdkVersion 写成资源引用，
 * 这里把引用 id 交给 resources.arsc 解析成整数。
 */
function resolveIntRef(arsc: ArscTable | null, id: number | null): number | null {
  if (!arsc || id === null || id === 0) return null
  try {
    return arsc.getInt(id)
  } catch {
    return null
  }
}

/** 应用名：字面字符串直接用，资源引用则查表 */
function resolveLabel(arsc: ArscTable | null, value: AxmlValue | null): string | null {
  if (!value) return null
  if (value.kind === 'string') {
    const t = value.value.trim()
    return t.length > 0 ? t : null
  }
  const id = attrRefId(value)
  if (id === null || id === 0 || !arsc) return null
  try {
    const s = arsc.getString(id)
    return s && s.trim().length > 0 ? s : null
  } catch {
    return null
  }
}

/* ------------------------------- 便捷导出 ------------------------------- */

export { ZipReader } from './zip'
export { ArscTable } from './arsc'
export { parseAxml, summarizeManifest, findLaunchableActivity } from './axml'

/** 判断某个路径是否像 APK（按扩展名，仅做 UI 层预筛） */
export function looksLikeApk(filePath: string): boolean {
  return /\.(apk|apks|xapk)$/i.test(filePath)
}

/** 只取 manifest 摘要的轻量入口（不做图标解析，快） */
export async function parseApkManifestOnly(filePath: string): Promise<ManifestSummary | null> {
  let zip: ZipReader | null = null
  try {
    zip = await ZipReader.open(filePath)
    const buf = await zip.readEntry(MANIFEST_ENTRY)
    if (!buf) return null
    return summarizeManifest(parseAxml(buf))
  } catch {
    return null
  } finally {
    if (zip) await zip.close().catch(() => undefined)
  }
}

export { nodeString, nodeNumber, attrRefId }
export type { ApkInfo }
