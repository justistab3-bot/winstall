/**
 * arsc.ts —— resources.arsc（ResTable）解析器
 *
 * 零依赖，只使用 Buffer。用途：
 *  - 把 `application@label` 的资源引用解析成应用名字符串；
 *  - 把 `application@icon` 的资源引用解析成 APK 内的文件路径（png/webp/xml）。
 *
 * 支持：
 *  - RES_TABLE(0x0002) / RES_STRING_POOL(0x0001) / RES_TABLE_PACKAGE(0x0200)
 *    / RES_TABLE_TYPE_SPEC(0x0202) / RES_TABLE_TYPE(0x0201)；
 *  - ResTable_type 的 FLAG_SPARSE(0x01) 与 FLAG_OFFSET16(0x02)；
 *  - config 择优：默认配置优先，图标场景下按 density 从高到低；
 *  - TYPE_REFERENCE 间接引用跟随（带深度上限防循环）。
 *
 * 任何解析失败都不会抛异常给调用方（构造时返回 null，查询返回 null）。
 */

/* --------------------------------- 常量 --------------------------------- */

const RES_STRING_POOL_TYPE = 0x0001
const RES_TABLE_TYPE = 0x0002
const RES_TABLE_PACKAGE_TYPE = 0x0200
const RES_TABLE_TYPE_TYPE = 0x0201
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202
const RES_TABLE_LIBRARY_TYPE = 0x0203

const TYPE_FLAG_SPARSE = 0x01
const TYPE_FLAG_OFFSET16 = 0x02

const ENTRY_FLAG_COMPLEX = 0x0001
const ENTRY_FLAG_COMPACT = 0x0008

const NO_ENTRY32 = 0xffffffff
const NO_ENTRY16 = 0xffff

const MAX_REF_DEPTH = 8
const MAX_ENTRIES_PER_CHUNK = 200000

/* Res_value 类型 */
const TYPE_NULL = 0x00
const TYPE_REFERENCE = 0x01
const TYPE_ATTRIBUTE = 0x02
const TYPE_STRING = 0x03
const TYPE_FLOAT = 0x04
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11
const TYPE_INT_BOOLEAN = 0x12

/** 判断一个 dataType 是否是 Res_value 的合法取值（用于 compact entry 的兼容猜测） */
function isKnownValueType(t: number): boolean {
  if (t <= 0x07) return true
  if (t >= 0x10 && t <= 0x12) return true
  if (t >= 0x1c && t <= 0x1f) return true
  return false
}

/** TYPE_INT_DEC / HEX / BOOLEAN / COLOR_* */
function isIntLikeType(t: number): boolean {
  return (t >= 0x10 && t <= 0x12) || (t >= 0x1c && t <= 0x1f)
}

/** TYPE_INT_COLOR_ARGB8 / RGB8 / ARGB4 / RGB4 */
function isColorType(t: number): boolean {
  return t >= 0x1c && t <= 0x1f
}

/* --------------------------------- 类型 --------------------------------- */

export interface ArscConfig {
  size: number
  mcc: number
  mnc: number
  language: string
  country: string
  orientation: number
  density: number
  sdkVersion: number
  /** 全 0 配置（默认资源） */
  isDefault: boolean
  /** 密度权重：density=0 视为 160；ANY(0xFFFE) 视为 0；NONE(0xFFFF) 视为 1 */
  densityScore: number
}

export interface ArscValue {
  /** Res_value.dataType */
  type: number
  data: number
  /** dataType === TYPE_STRING 时已解析出的字符串 */
  str: string | null
}

export type ArscEntryValue =
  | { kind: 'value'; value: ArscValue; key: string | null }
  | { kind: 'map'; map: Map<number, ArscValue>; key: string | null }

export interface ArscTypeChunk {
  typeId: number
  typeName: string | null
  config: ArscConfig
  entries: Map<number, ArscEntryValue>
}

export interface ArscPackageInfo {
  id: number
  name: string
  typeNames: string[]
  keyNames: string[]
}

export interface ArscCandidate {
  config: ArscConfig
  entry: ArscEntryValue
  typeName: string | null
}

/* ------------------------------- 小工具函数 ------------------------------ */

function u16(buf: Buffer, off: number): number {
  return off + 2 <= buf.length ? buf.readUInt16LE(off) : 0
}

function u32(buf: Buffer, off: number): number {
  return off + 4 <= buf.length ? buf.readUInt32LE(off) : 0
}

function u8(buf: Buffer, off: number): number {
  return off < buf.length ? buf.readUInt8(off) : 0
}

/** 解包 ResTable_config 里的 language/country（2 字节 ASCII 或 3 字节 base-31 打包） */
function unpackLocalePart(buf: Buffer, off: number, base: number): string {
  const b0 = u8(buf, off)
  const b1 = u8(buf, off + 1)
  if (b0 === 0 && b1 === 0) return ''
  if ((b0 & 0x80) !== 0) {
    const c0 = (b1 & 0x1f) + base
    const c1 = (((b1 & 0xe0) >> 5) | ((b0 & 0x03) << 3)) + base
    const c2 = ((b0 & 0x7c) >> 2) + base
    return String.fromCharCode(c0, c1, c2)
  }
  return String.fromCharCode(b0, b1)
}

function parseConfig(buf: Buffer, off: number, limit: number): ArscConfig {
  const size = off + 4 <= limit ? buf.readUInt32LE(off) : 0
  const usable = Math.max(0, Math.min(size, limit - off))
  const cfg: ArscConfig = {
    size,
    mcc: 0,
    mnc: 0,
    language: '',
    country: '',
    orientation: 0,
    density: 0,
    sdkVersion: 0,
    isDefault: true,
    densityScore: 160
  }
  if (usable >= 8) {
    cfg.mcc = u16(buf, off + 4)
    cfg.mnc = u16(buf, off + 6)
  }
  if (usable >= 12) {
    cfg.language = unpackLocalePart(buf, off + 8, 0x61)
    cfg.country = unpackLocalePart(buf, off + 10, 0x30)
  }
  if (usable >= 13) cfg.orientation = u8(buf, off + 12)
  if (usable >= 16) cfg.density = u16(buf, off + 14)
  if (usable >= 26) cfg.sdkVersion = u16(buf, off + 24)

  let allZero = true
  for (let i = 4; i < usable; i++) {
    if (buf.readUInt8(off + i) !== 0) {
      allZero = false
      break
    }
  }
  cfg.isDefault = size <= 4 || allZero

  if (cfg.density === 0) cfg.densityScore = 160
  else if (cfg.density === 0xfffe) cfg.densityScore = 0 // ANY
  else if (cfg.density === 0xffff) cfg.densityScore = 1 // NONE
  else cfg.densityScore = cfg.density

  return cfg
}

/* ------------------------------ StringPool ------------------------------ */

function decodeLength8(buf: Buffer, p: number, limit: number): { len: number; next: number } {
  if (p >= limit) return { len: 0, next: p }
  let len = buf.readUInt8(p)
  p += 1
  if (len & 0x80) {
    if (p >= limit) return { len: len & 0x7f, next: p }
    len = ((len & 0x7f) << 8) | buf.readUInt8(p)
    p += 1
  }
  return { len, next: p }
}

function decodeLength16(buf: Buffer, p: number, limit: number): { len: number; next: number } {
  if (p + 2 > limit) return { len: 0, next: p }
  let len = buf.readUInt16LE(p)
  p += 2
  if (len & 0x8000) {
    if (p + 2 > limit) return { len: len & 0x7fff, next: p }
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p)
    p += 2
  }
  return { len, next: p }
}

function parseStringPool(buf: Buffer, start: number, limit: number): string[] {
  if (start < 0 || start + 28 > limit) return []
  if (u16(buf, start) !== RES_STRING_POOL_TYPE) return []
  const headerSize = u16(buf, start + 2)
  const chunkSize = u32(buf, start + 4)
  const chunkEnd = Math.min(start + chunkSize, limit)
  const stringCount = u32(buf, start + 8)
  const flags = u32(buf, start + 16)
  const stringsStart = u32(buf, start + 20)
  const isUtf8 = (flags & 0x100) !== 0
  if (stringCount > 500000) return []

  const offsetsBase = start + headerSize
  const dataBase = start + stringsStart
  const out: string[] = new Array<string>(stringCount).fill('')

  for (let i = 0; i < stringCount; i++) {
    const offPos = offsetsBase + i * 4
    if (offPos + 4 > chunkEnd) break
    const offset = buf.readUInt32LE(offPos)
    if (offset === NO_ENTRY32) continue
    const p = dataBase + offset
    if (p < 0 || p >= chunkEnd) continue
    try {
      if (isUtf8) {
        const l1 = decodeLength8(buf, p, chunkEnd)
        const l2 = decodeLength8(buf, l1.next, chunkEnd)
        const from = l2.next
        const to = Math.min(from + l2.len, chunkEnd)
        out[i] = from >= to ? '' : buf.toString('utf8', from, to)
      } else {
        const l = decodeLength16(buf, p, chunkEnd)
        const from = l.next
        const to = Math.min(from + l.len * 2, chunkEnd)
        out[i] = from >= to ? '' : buf.toString('utf16le', from, to)
      }
    } catch {
      out[i] = ''
    }
  }
  return out
}

/* -------------------------------- 主解析器 ------------------------------- */

export class ArscTable {
  private readonly globalStrings: string[]
  private readonly packages = new Map<number, ArscPackageInfo>()
  private readonly chunksByPackage = new Map<number, Map<number, ArscTypeChunk[]>>()

  private constructor(globalStrings: string[]) {
    this.globalStrings = globalStrings
  }

  /** 解析 resources.arsc；失败返回 null（绝不抛异常） */
  static parse(data: Buffer): ArscTable | null {
    try {
      if (!Buffer.isBuffer(data) || data.length < 12) return null
      if (u16(data, 0) !== RES_TABLE_TYPE) return null
      const headerSize = u16(data, 2)
      const declared = u32(data, 4)
      const limit = Math.min(declared > 0 ? declared : data.length, data.length)

      // 全局字符串池紧跟在 ResTable header 之后
      let globalStrings: string[] = []
      let p = headerSize >= 12 ? headerSize : 12
      if (p + 8 <= limit && u16(data, p) === RES_STRING_POOL_TYPE) {
        globalStrings = parseStringPool(data, p, limit)
      }

      const table = new ArscTable(globalStrings)
      while (p + 8 <= limit) {
        const chunkType = u16(data, p)
        const chunkSize = u32(data, p + 4)
        if (chunkSize < 8 || p + chunkSize > limit) break
        if (chunkType === RES_TABLE_PACKAGE_TYPE) {
          table.parsePackage(data, p, limit)
        }
        p += chunkSize
      }
      return table
    } catch {
      return null
    }
  }

  /* ------------------------------ 对外查询 ------------------------------ */

  /** 已解析出的包（调试用） */
  listPackages(): ArscPackageInfo[] {
    return [...this.packages.values()]
  }

  /** 资源 id → 字符串；支持 TYPE_REFERENCE 间接引用 */
  getString(resId: number): string | null {
    return this.getStringInternal(resId >>> 0, 0, 'default')
  }

  /** 资源 id → 整数（TYPE_INT_* / 颜色 / 可解析的数字字符串） */
  getInt(resId: number): number | null {
    return this.getIntInternal(resId >>> 0, 0)
  }

  /** 资源 id → ARGB 颜色（仅当值的类型确实是颜色时返回，否则 null） */
  getColor(resId: number): number | null {
    return this.getColorInternal(resId >>> 0, 0)
  }

  /** 资源 id → 文件路径（如 res/mipmap-hdpi/ic_launcher.png），按密度择优 */
  getFileEntry(resId: number): string | null {
    const s = this.getStringInternal(resId >>> 0, 0, 'density')
    return s && s.length > 0 ? s : null
  }

  /**
   * 资源 id 在所有 config 下的字符串值（按优先级排序）。
   * 图标场景下需要遍历所有候选（先高密度位图，再 anydpi 的 xml）。
   */
  getStringCandidates(resId: number): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const cand of this.getCandidates(resId >>> 0, 'density')) {
      const s = this.valueToString(cand.entry, 0, 'density')
      if (s && !seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
    }
    return out
  }

  /** 资源 id 是否存在 */
  hasResource(resId: number): boolean {
    return this.getCandidates(resId >>> 0, 'default').length > 0
  }

  /** 全局字符串池（调试用） */
  getGlobalStringCount(): number {
    return this.globalStrings.length
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  private parsePackage(buf: Buffer, start: number, limit: number): void {
    const headerSize = u16(buf, start + 2)
    const chunkSize = u32(buf, start + 4)
    const chunkEnd = Math.min(start + chunkSize, limit)
    const id = u32(buf, start + 8)
    // name 是 char16[128]
    let name = ''
    try {
      const raw = buf.toString('utf16le', start + 12, Math.min(start + 12 + 256, chunkEnd))
      name = raw.replace(/\u0000.*$/s, '')
    } catch {
      name = ''
    }
    const typeStringsOff = u32(buf, start + 268)
    const keyStringsOff = u32(buf, start + 276)

    const typeNames =
      typeStringsOff > 0 ? parseStringPool(buf, start + typeStringsOff, chunkEnd) : []
    const keyNames = keyStringsOff > 0 ? parseStringPool(buf, start + keyStringsOff, chunkEnd) : []

    this.packages.set(id, { id, name, typeNames, keyNames })
    const byType = new Map<number, ArscTypeChunk[]>()
    this.chunksByPackage.set(id, byType)

    let p = start + (headerSize >= 284 ? headerSize : 288)
    while (p + 8 <= chunkEnd) {
      const chunkType = u16(buf, p)
      const size = u32(buf, p + 4)
      if (size < 8 || p + size > chunkEnd) break
      if (chunkType === RES_TABLE_TYPE_TYPE) {
        const chunk = parseTypeChunk(buf, p, chunkEnd, typeNames, keyNames)
        if (chunk) {
          const list = byType.get(chunk.typeId)
          if (list) list.push(chunk)
          else byType.set(chunk.typeId, [chunk])
        }
      } else if (
        chunkType !== RES_TABLE_TYPE_SPEC_TYPE &&
        chunkType !== RES_STRING_POOL_TYPE &&
        chunkType !== RES_TABLE_LIBRARY_TYPE
      ) {
        // 未知 chunk：安全跳过
      }
      p += size
    }
  }

  /** 找到资源 id 对应的所有 (config, entry) 候选，按优先级排序 */
  private getCandidates(resId: number, mode: 'default' | 'density'): ArscCandidate[] {
    const packageId = (resId >>> 24) & 0xff
    const typeId = (resId >>> 16) & 0xff
    const entryIndex = resId & 0xffff
    if (resId === 0) return []

    let byType = this.chunksByPackage.get(packageId)
    if (!byType && this.chunksByPackage.size === 1) {
      // 有些包 packageId 不是 0x7f（例如 0x02 的 shared library），做一次宽容匹配
      const only = [...this.chunksByPackage.values()][0]
      byType = only
    }
    if (!byType) return []
    const chunks = byType.get(typeId)
    if (!chunks || chunks.length === 0) return []

    const out: ArscCandidate[] = []
    for (const chunk of chunks) {
      const entry = chunk.entries.get(entryIndex)
      if (entry) out.push({ config: chunk.config, entry, typeName: chunk.typeName })
    }
    if (out.length <= 1) return out

    out.sort((a, b) => this.compareConfig(a.config, b.config, mode))
    return out
  }

  private compareConfig(a: ArscConfig, b: ArscConfig, mode: 'default' | 'density'): number {
    // 带 locale 的配置永远排后面（应用名/图标只关心默认语言）
    const aLocale = a.language !== '' || a.country !== '' ? 1 : 0
    const bLocale = b.language !== '' || b.country !== '' ? 1 : 0
    if (aLocale !== bLocale) return aLocale - bLocale

    if (mode === 'default') {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      if (a.densityScore !== b.densityScore) return b.densityScore - a.densityScore
    } else {
      if (a.densityScore !== b.densityScore) return b.densityScore - a.densityScore
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    }
    // sdkVersion 更小的更通用，排前面
    if (a.sdkVersion !== b.sdkVersion) return a.sdkVersion - b.sdkVersion
    return 0
  }

  private getStringInternal(resId: number, depth: number, mode: 'default' | 'density'): string | null {
    if (depth > MAX_REF_DEPTH) return null
    for (const cand of this.getCandidates(resId, mode)) {
      const s = this.valueToString(cand.entry, depth, mode)
      if (s !== null) return s
    }
    return null
  }

  private getIntInternal(resId: number, depth: number): number | null {
    if (depth > MAX_REF_DEPTH) return null
    for (const cand of this.getCandidates(resId, 'default')) {
      const v = firstValue(cand.entry)
      if (!v) continue
      if (isIntLikeType(v.type)) {
        return v.data | 0
      }
      if (v.type === TYPE_REFERENCE || v.type === TYPE_ATTRIBUTE) {
        const nested = this.getIntInternal(v.data >>> 0, depth + 1)
        if (nested !== null) return nested
      }
      if (v.type === TYPE_STRING && v.str !== null) {
        const n = Number(v.str)
        if (Number.isFinite(n)) return n
      }
    }
    return null
  }

  private getColorInternal(resId: number, depth: number): number | null {
    if (depth > MAX_REF_DEPTH) return null
    for (const cand of this.getCandidates(resId, 'default')) {
      const v = firstValue(cand.entry)
      if (!v) continue
      if (isColorType(v.type)) return v.data >>> 0
      if (v.type === TYPE_REFERENCE) {
        const nested = this.getColorInternal(v.data >>> 0, depth + 1)
        if (nested !== null) return nested
      }
    }
    return null
  }

  private valueToString(entry: ArscEntryValue, depth: number, mode: 'default' | 'density'): string | null {
    if (depth > MAX_REF_DEPTH) return null
    if (entry.kind === 'map') {
      // 复杂条目（style/array 等）对应用名/图标没有意义
      return null
    }
    const v = entry.value
    switch (v.type) {
      case TYPE_STRING:
        if (v.str !== null) return v.str
        return v.data < this.globalStrings.length ? this.globalStrings[v.data] : null
      case TYPE_REFERENCE:
        return this.getStringInternal(v.data >>> 0, depth + 1, mode)
      case TYPE_INT_DEC:
      case TYPE_INT_HEX:
      case TYPE_INT_BOOLEAN:
        return String(v.data | 0)
      case TYPE_FLOAT: {
        const tmp = Buffer.allocUnsafe(4)
        tmp.writeUInt32LE(v.data >>> 0, 0)
        return String(tmp.readFloatLE(0))
      }
      default:
        return null
    }
  }
}

/* --------------------------- 单个 ResTable_type -------------------------- */

function parseTypeChunk(
  buf: Buffer,
  start: number,
  limit: number,
  typeNames: string[],
  keyNames: string[]
): ArscTypeChunk | null {
  const headerSize = u16(buf, start + 2)
  const chunkSize = u32(buf, start + 4)
  const chunkEnd = Math.min(start + chunkSize, limit)
  const typeId = u8(buf, start + 8)
  const flags = u8(buf, start + 9)
  const entryCount = u32(buf, start + 12)
  const entriesStart = u32(buf, start + 16)
  if (entryCount > MAX_ENTRIES_PER_CHUNK) return null

  const config = parseConfig(buf, start + 20, chunkEnd)

  // 偏移数组通常紧跟在 headerSize 之后；headerSize 异常时退回 20 + config.size
  let offsetsBase = start + headerSize
  const perEntry = (flags & TYPE_FLAG_SPARSE) !== 0 ? 4 : (flags & TYPE_FLAG_OFFSET16) !== 0 ? 2 : 4
  const needBytes = entryCount * perEntry
  if (offsetsBase < start + 20 || offsetsBase + needBytes > chunkEnd) {
    const alt = start + 20 + Math.max(config.size, 4)
    const altAligned = alt + ((4 - (alt % 4)) % 4)
    if (altAligned + needBytes <= chunkEnd) offsetsBase = altAligned
    else if (offsetsBase + needBytes > chunkEnd) return null
  }

  const dataBase = start + entriesStart
  if (dataBase > chunkEnd) return null

  const entries = new Map<number, ArscEntryValue>()
  // 注意：ResTable 的 typeId 是 **1 起始**，typeStrings 池下标 0 对应 typeId 1
  const typeName = typeId >= 1 && typeId - 1 < typeNames.length ? typeNames[typeId - 1] : null

  const readAt = (entryIndex: number, offset: number): void => {
    if (offset === NO_ENTRY32 || offset === NO_ENTRY16) return
    const pos = dataBase + offset
    if (pos < 0 || pos + 8 > chunkEnd) return
    const parsed = parseEntry(buf, pos, chunkEnd, keyNames)
    if (parsed) entries.set(entryIndex, parsed)
  }

  if ((flags & TYPE_FLAG_SPARSE) !== 0) {
    // ResTable_sparseTypeEntry { uint16 idx; uint16 offset(单位 4 字节) }
    for (let i = 0; i < entryCount; i++) {
      const p = offsetsBase + i * 4
      if (p + 4 > chunkEnd) break
      const idx = buf.readUInt16LE(p)
      const off = buf.readUInt16LE(p + 2)
      if (idx === 0xffff) continue
      readAt(idx, off * 4)
    }
  } else if ((flags & TYPE_FLAG_OFFSET16) !== 0) {
    for (let i = 0; i < entryCount; i++) {
      const p = offsetsBase + i * 2
      if (p + 2 > chunkEnd) break
      const off = buf.readUInt16LE(p)
      if (off === NO_ENTRY16) continue
      readAt(i, off * 4)
    }
  } else {
    for (let i = 0; i < entryCount; i++) {
      const p = offsetsBase + i * 4
      if (p + 4 > chunkEnd) break
      const off = buf.readUInt32LE(p)
      if (off === NO_ENTRY32) continue
      readAt(i, off)
    }
  }

  return { typeId, typeName, config, entries }
}

function firstValue(entry: ArscEntryValue): ArscValue | null {
  return entry.kind === 'value' ? entry.value : null
}

function parseEntry(
  buf: Buffer,
  pos: number,
  limit: number,
  keyNames: string[]
): ArscEntryValue | null {
  if (pos + 8 > limit) return null
  const entrySize = buf.readUInt16LE(pos)
  const entryFlags = buf.readUInt16LE(pos + 2)
  const keyIndex = buf.readUInt32LE(pos + 4)
  const key = keyIndex === NO_ENTRY32 ? null : keyNames[keyIndex] ?? null

  if ((entryFlags & ENTRY_FLAG_COMPLEX) !== 0) {
    if (pos + 16 > limit) return null
    const count = buf.readUInt32LE(pos + 12)
    const map = new Map<number, ArscValue>()
    let mp = pos + 16
    for (let i = 0; i < count && mp + 12 <= limit; i++, mp += 12) {
      const nameId = buf.readUInt32LE(mp)
      const v = readResValue(buf, mp + 4, limit)
      if (v) map.set(nameId >>> 0, v)
    }
    return { kind: 'map', map, key }
  }

  if ((entryFlags & ENTRY_FLAG_COMPACT) !== 0) {
    // 紧凑条目：Res_value 被打包进 (size, flags, key) 三元组。
    // AOSP 各版本略有差异，这里做两种解释的兼容判断。
    const packedA = ((entrySize & 0xff) << 24) | ((entryFlags & 0xff) << 8) | (keyIndex & 0xffff)
    const typeA = (entrySize >> 8) & 0xff
    if (isKnownValueType(typeA) && (typeA !== TYPE_STRING || packedA < 65536)) {
      return { kind: 'value', value: { type: typeA, data: packedA >>> 0, str: null }, key }
    }
    const typeB = (keyIndex >>> 24) & 0xff
    if (isKnownValueType(typeB)) {
      return { kind: 'value', value: { type: typeB, data: keyIndex & 0xffffff, str: null }, key }
    }
    return null
  }

  const valuePos = pos + (entrySize >= 8 ? entrySize : 8)
  const v = readResValue(buf, valuePos, limit)
  return v ? { kind: 'value', value: v, key } : null
}

function readResValue(buf: Buffer, pos: number, limit: number): ArscValue | null {
  if (pos + 8 > limit) return null
  const dataType = buf.readUInt8(pos + 3)
  const data = buf.readUInt32LE(pos + 4) >>> 0
  return { type: dataType, data, str: null }
}

export {
  TYPE_NULL,
  TYPE_REFERENCE,
  TYPE_ATTRIBUTE,
  TYPE_STRING,
  TYPE_FLOAT,
  TYPE_INT_DEC,
  TYPE_INT_HEX,
  TYPE_INT_BOOLEAN
}
