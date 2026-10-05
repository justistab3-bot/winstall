/**
 * zip.ts —— 零依赖最小 ZIP 读取器（只读）
 *
 * 设计要点：
 *  - 只依赖 node:fs / node:zlib，不引入任何 npm 包；
 *  - 随机读取：用 fs.promises.open + FileHandle.read(buffer, off, len, position)
 *    只读需要的字节区间，绝不把整个 APK 读进内存（APK 可能几百 MB）；
 *  - 中央目录一次性读入（通常几百 KB ~ 2MB），条目按需解压；
 *  - 支持 ZIP64（EOCD64 定位器 + EOCD64 记录）与中央目录损坏时的兜底扫描；
 *  - 遇到加密条目 / data descriptor / 未知压缩方法时返回 null，不抛异常。
 */

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

/* --------------------------------- 常量 --------------------------------- */

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_EOCD64 = 0x06064b50
const SIG_CDFH = 0x02014b50
const SIG_LFH = 0x04034b50

/** EOCD 固定 22 字节 + 最长 65535 字节注释 */
const EOCD_MIN_SIZE = 22
const MAX_TAIL_SCAN = 0xffff + EOCD_MIN_SIZE

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008

/** 单个条目解压上限，防御性上限（正常 APK 条目不会这么大） */
const MAX_ENTRY_SIZE = 256 * 1024 * 1024
/** LRU 缓存上限 */
const CACHE_MAX_BYTES = 8 * 1024 * 1024
const CACHE_MAX_ENTRIES = 24

/* --------------------------------- 类型 --------------------------------- */

export interface ZipEntry {
  /** 条目路径，如 `res/mipmap-hdpi/ic_launcher.png` */
  fileName: string
  compressedSize: number
  uncompressedSize: number
  /** 0 = store，8 = deflate */
  compressionMethod: number
  /** 本地文件头偏移（数据起点需要再叠加 30 + nameLen + extraLen） */
  localHeaderOffset: number
  crc32: number
  flags: number
  isDirectory: boolean
}

/** 数据来源抽象：文件句柄 或 内存 Buffer */
interface ZipSource {
  readonly size: number
  read(offset: number, length: number): Promise<Buffer>
  close(): Promise<void>
}

class FileSource implements ZipSource {
  constructor(private readonly handle: FileHandle, readonly size: number) {}

  async read(offset: number, length: number): Promise<Buffer> {
    const len = Math.max(0, Math.min(length, this.size - offset))
    const buf = Buffer.allocUnsafe(len)
    let done = 0
    while (done < len) {
      const { bytesRead } = await this.handle.read(buf, done, len - done, offset + done)
      if (bytesRead <= 0) break
      done += bytesRead
    }
    return done === len ? buf : buf.subarray(0, done)
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined)
  }
}

class BufferSource implements ZipSource {
  constructor(readonly buf: Buffer) {}

  get size(): number {
    return this.buf.length
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const len = Math.max(0, Math.min(length, this.buf.length - offset))
    return this.buf.subarray(offset, offset + len)
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

/* ------------------------------- 小工具函数 ------------------------------ */

async function readFully(
  src: ZipSource,
  offset: number,
  length: number
): Promise<Buffer | null> {
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return null
  if (offset < 0 || length < 0 || offset >= src.size) return null
  const buf = await src.read(offset, length)
  return buf.length === 0 ? null : buf
}

function u16(buf: Buffer, off: number): number {
  return off + 2 <= buf.length ? buf.readUInt16LE(off) : 0
}

function u32(buf: Buffer, off: number): number {
  return off + 4 <= buf.length ? buf.readUInt32LE(off) : 0
}

function u64(buf: Buffer, off: number): number {
  if (off + 8 > buf.length) return Number.NaN
  const v = buf.readBigUInt64LE(off)
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number.NaN
}

function safeInt(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : -1
}

/* ------------------------------ 中央目录解析 ----------------------------- */

interface CentralDirectory {
  entries: ZipEntry[]
  cdStart: number
  cdSize: number
}

/** 从文件尾部向前扫描 EOCD（最多 64KB，兼容 ZIP 注释） */
function locateEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue
    const commentLen = tail.readUInt16LE(i + 20)
    // 注释长度必须与剩余字节吻合，避免注释里恰好出现签名导致的误判
    if (i + EOCD_MIN_SIZE + commentLen <= tail.length) return i
  }
  return -1
}

async function looksLikeCdfh(src: ZipSource, offset: number): Promise<boolean> {
  if (offset < 0 || offset + 4 > src.size) return false
  const head = await readFully(src, offset, 4)
  return head !== null && head.readUInt32LE(0) === SIG_CDFH
}

/** 中央目录偏移不可信时，逐块扫描 CDFH 签名作为兜底 */
async function scanForCdfh(src: ZipSource): Promise<number> {
  const CHUNK = 1 << 20
  let pos = 0
  while (pos < src.size) {
    const buf = await readFully(src, pos, Math.min(CHUNK + 3, src.size - pos))
    if (!buf) break
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf.readUInt32LE(i) === SIG_CDFH) return pos + i
    }
    if (buf.length < CHUNK) break
    pos += CHUNK
  }
  return -1
}

function applyZip64Extra(entry: ZipEntry, extra: Buffer): void {
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    const body = p + 4
    const end = body + len
    if (end > extra.length) break
    if (id === 0x0001) {
      let q = body
      if (entry.uncompressedSize === 0xffffffff && q + 8 <= end) {
        entry.uncompressedSize = u64(extra, q)
        q += 8
      }
      if (entry.compressedSize === 0xffffffff && q + 8 <= end) {
        entry.compressedSize = u64(extra, q)
        q += 8
      }
      if (entry.localHeaderOffset === 0xffffffff && q + 8 <= end) {
        entry.localHeaderOffset = u64(extra, q)
        q += 8
      }
      break
    }
    p = end
  }
}

function parseCentralDirectory(cd: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CDFH) {
    const flags = u16(cd, p + 8)
    const method = u16(cd, p + 10)
    const crc32 = u32(cd, p + 16)
    const nameLen = u16(cd, p + 28)
    const extraLen = u16(cd, p + 30)
    const commentLen = u16(cd, p + 32)
    const nameStart = p + 46
    if (nameStart + nameLen > cd.length) break
    const fileName = cd.toString('utf8', nameStart, nameStart + nameLen)
    const entry: ZipEntry = {
      fileName,
      compressedSize: u32(cd, p + 20),
      uncompressedSize: u32(cd, p + 24),
      compressionMethod: method,
      localHeaderOffset: u32(cd, p + 42),
      crc32,
      flags,
      isDirectory: fileName.endsWith('/')
    }
    const extraStart = nameStart + nameLen
    if (extraLen > 0 && extraStart + extraLen <= cd.length) {
      applyZip64Extra(entry, cd.subarray(extraStart, extraStart + extraLen))
    }
    if (entry.compressedSize < 0 || entry.uncompressedSize < 0) break
    entries.push(entry)
    p = extraStart + extraLen + commentLen
  }
  return entries
}

async function readCentralDirectory(src: ZipSource): Promise<CentralDirectory> {
  if (src.size < EOCD_MIN_SIZE) throw new Error('文件过小，不是有效的 ZIP')

  const tailLen = Math.min(src.size, MAX_TAIL_SCAN)
  const tailStart = src.size - tailLen
  const tail = await readFully(src, tailStart, tailLen)
  if (!tail) throw new Error('无法读取文件尾部')

  const eocdPos = locateEocd(tail)
  if (eocdPos < 0) throw new Error('未找到 EOCD 签名，不是有效的 ZIP/APK')
  const eocdFileOffset = tailStart + eocdPos

  let cdSize = safeInt(u32(tail, eocdPos + 12))
  let cdStart = safeInt(u32(tail, eocdPos + 16))

  /* ------------------------------ ZIP64 ------------------------------ */
  let locatorOffset = -1
  if (eocdFileOffset >= 20) {
    const loc = await readFully(src, eocdFileOffset - 20, 20)
    if (loc && u32(loc, 0) === SIG_EOCD64_LOCATOR) {
      locatorOffset = eocdFileOffset - 20
      const eocd64Offset = u64(loc, 8)
      if (Number.isFinite(eocd64Offset) && eocd64Offset >= 0 && eocd64Offset + 56 <= src.size) {
        const rec = await readFully(src, eocd64Offset, 56)
        if (rec && u32(rec, 0) === SIG_EOCD64) {
          const z64CdSize = u64(rec, 40)
          const z64CdStart = u64(rec, 48)
          if (Number.isFinite(z64CdSize) && z64CdSize > 0) cdSize = safeInt(z64CdSize)
          if (Number.isFinite(z64CdStart) && z64CdStart >= 0) cdStart = safeInt(z64CdStart)
        }
      }
    }
  }

  /* --------------------- 校验 / 兜底重建中央目录位置 --------------------- */
  const candidates = [
    cdStart,
    cdSize > 0 ? eocdFileOffset - cdSize : -1,
    cdSize > 0 && locatorOffset > 0 ? locatorOffset - cdSize : -1
  ]
  let resolved = -1
  for (const cand of candidates) {
    if (cand < 0) continue
    if (await looksLikeCdfh(src, cand)) {
      resolved = cand
      break
    }
  }
  if (resolved < 0) resolved = await scanForCdfh(src)
  if (resolved < 0) throw new Error('中央目录损坏：找不到 CDFH 签名')
  cdStart = resolved

  if (cdSize <= 0 || cdStart + cdSize > src.size) {
    // 用「下一个已知位置 - 起点」估算，失败则读到文件末尾
    cdSize = (locatorOffset > cdStart ? locatorOffset : src.size) - cdStart
  }
  const cd = await readFully(src, cdStart, cdSize)
  if (!cd) throw new Error('无法读取中央目录')

  const entries = parseCentralDirectory(cd)
  if (entries.length === 0) throw new Error('中央目录为空或格式无法识别')
  return { entries, cdStart, cdSize }
}

/* -------------------------------- 主类 -------------------------------- */

export class ZipReader {
  private readonly byName = new Map<string, ZipEntry>()
  private readonly cache = new Map<string, Buffer>()
  private cacheBytes = 0
  private closed = false

  private constructor(
    private readonly src: ZipSource,
    readonly filePath: string,
    readonly fileSize: number,
    private readonly entries: ZipEntry[]
  ) {
    for (const e of entries) {
      if (!this.byName.has(e.fileName)) this.byName.set(e.fileName, e)
    }
  }

  /** 打开一个 APK/ZIP 文件（只读，不加载全文件） */
  static async open(filePath: string): Promise<ZipReader> {
    const handle = await fsp.open(filePath, 'r')
    try {
      const st = await handle.stat()
      const src = new FileSource(handle, st.size)
      const cd = await readCentralDirectory(src)
      return new ZipReader(src, filePath, st.size, cd.entries)
    } catch (err) {
      await handle.close().catch(() => undefined)
      throw err
    }
  }

  /** 从内存 Buffer 构造（测试 / 小文件用，中央目录同步解析） */
  static fromBuffer(buf: Buffer, label = '<buffer>'): ZipReader {
    const cd = readCentralDirectoryFromBuffer(buf)
    return new ZipReader(new BufferSource(buf), label, buf.length, cd.entries)
  }

  /** 全部条目（只读数组的浅拷贝） */
  listEntries(): ZipEntry[] {
    return this.entries.slice()
  }

  /** 条目名列表 */
  listNames(): string[] {
    return this.entries.map((e) => e.fileName)
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined
  }

  getEntry(name: string): ZipEntry | undefined {
    return this.lookup(name)
  }

  /** 读取并解压一个条目；失败（加密/未知方法/损坏）返回 null */
  async readEntry(name: string): Promise<Buffer | null> {
    const entry = this.lookup(name)
    if (!entry) return null
    const cached = this.cache.get(entry.fileName)
    if (cached) {
      // LRU：命中后移到队尾
      this.cache.delete(entry.fileName)
      this.cache.set(entry.fileName, cached)
      return cached
    }
    const data = await this.extract(entry)
    if (data) this.remember(entry.fileName, data)
    return data
  }

  /** 读取条目并当作 UTF-8 文本返回 */
  async readText(name: string): Promise<string | null> {
    const buf = await this.readEntry(name)
    return buf ? buf.toString('utf8') : null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cache.clear()
    this.cacheBytes = 0
    await this.src.close()
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  private lookup(name: string): ZipEntry | undefined {
    const direct = this.byName.get(name)
    if (direct) return direct
    const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
    return this.byName.get(normalized)
  }

  private remember(name: string, data: Buffer): void {
    if (data.length > CACHE_MAX_BYTES / 2) return
    this.cache.set(name, data)
    this.cacheBytes += data.length
    while (
      (this.cacheBytes > CACHE_MAX_BYTES || this.cache.size > CACHE_MAX_ENTRIES) &&
      this.cache.size > 0
    ) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      const victim = this.cache.get(oldest.value)
      this.cache.delete(oldest.value)
      if (victim) this.cacheBytes -= victim.length
    }
  }

  /** 解压单个条目 */
  private async extract(entry: ZipEntry): Promise<Buffer | null> {
    if (entry.flags & FLAG_ENCRYPTED) return null
    if (entry.compressionMethod !== METHOD_STORE && entry.compressionMethod !== METHOD_DEFLATE) {
      return null
    }
    if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > this.src.size) return null

    // 关键：数据起点必须用「本地文件头」里的 name/extra 长度重新计算，
    // 中央目录里的 localHeaderOffset 只是本地头的位置，不是数据位置。
    const lfh = await readFully(this.src, entry.localHeaderOffset, 30)
    if (!lfh || u32(lfh, 0) !== SIG_LFH) return null
    const nameLen = u16(lfh, 26)
    const extraLen = u16(lfh, 28)
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen
    if (dataStart >= this.src.size) return null

    let compSize = entry.compressedSize
    let raw: Buffer | null = null

    if (compSize > 0 && dataStart + compSize <= this.src.size) {
      raw = await readFully(this.src, dataStart, compSize)
    } else {
      // 中央目录大小不可信（streaming + data descriptor）：退化为按边界推断
      raw = await this.extractWithDescriptor(entry, dataStart)
    }
    if (!raw) return null
    if (raw.length > MAX_ENTRY_SIZE) return null

    if (entry.compressionMethod === METHOD_STORE) {
      return raw
    }
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE })
    } catch {
      return null
    }
  }

  /** data descriptor 场景：用相邻条目的本地头位置推断压缩数据结尾 */
  private async extractWithDescriptor(entry: ZipEntry, dataStart: number): Promise<Buffer | null> {
    let end = this.src.size
    for (const other of this.entries) {
      if (other === entry) continue
      if (other.localHeaderOffset > entry.localHeaderOffset && other.localHeaderOffset < end) {
        end = other.localHeaderOffset
      }
    }
    if (end <= dataStart) return null
    const whole = await readFully(this.src, dataStart, end - dataStart)
    if (!whole) return null
    if (entry.compressionMethod === METHOD_STORE) return whole
    // data descriptor 为 12 或 16 字节，逐个尝试
    for (const tail of [0, 12, 16]) {
      const slice = tail === 0 ? whole : whole.subarray(0, whole.length - tail)
      if (slice.length <= 0) continue
      try {
        return inflateRawSync(slice, { maxOutputLength: MAX_ENTRY_SIZE })
      } catch {
        /* 继续尝试 */
      }
    }
    // 兜底：宽容模式，容忍尾部多余字节
    try {
      return inflateRawSync(whole, { maxOutputLength: MAX_ENTRY_SIZE })
    } catch {
      return null
    }
  }
}

/* --------------------- 同步变体（仅供 fromBuffer 使用） -------------------- */

function readCentralDirectoryFromBuffer(buf: Buffer): CentralDirectory {
  const tailLen = Math.min(buf.length, MAX_TAIL_SCAN)
  const tailStart = buf.length - tailLen
  const tail = buf.subarray(tailStart)
  const eocdPos = locateEocd(tail)
  if (eocdPos < 0) throw new Error('未找到 EOCD 签名，不是有效的 ZIP/APK')
  const eocdFileOffset = tailStart + eocdPos
  let cdSize = safeInt(u32(tail, eocdPos + 12))
  let cdStart = safeInt(u32(tail, eocdPos + 16))
  if (eocdFileOffset >= 20) {
    const loc = buf.subarray(eocdFileOffset - 20, eocdFileOffset)
    if (u32(loc, 0) === SIG_EOCD64_LOCATOR) {
      const eocd64Offset = u64(loc, 8)
      if (Number.isFinite(eocd64Offset) && eocd64Offset + 56 <= buf.length) {
        const rec = buf.subarray(eocd64Offset, eocd64Offset + 56)
        if (u32(rec, 0) === SIG_EOCD64) {
          const zs = u64(rec, 40)
          const zo = u64(rec, 48)
          if (Number.isFinite(zs) && zs > 0) cdSize = safeInt(zs)
          if (Number.isFinite(zo) && zo >= 0) cdStart = safeInt(zo)
        }
      }
    }
  }
  if (cdStart < 0 || cdStart + 4 > buf.length || u32(buf, cdStart) !== SIG_CDFH) {
    cdStart = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    if (cdStart < 0) throw new Error('中央目录损坏：找不到 CDFH 签名')
  }
  if (cdSize <= 0 || cdStart + cdSize > buf.length) cdSize = buf.length - cdStart
  const entries = parseCentralDirectory(buf.subarray(cdStart, cdStart + cdSize))
  if (entries.length === 0) throw new Error('中央目录为空或格式无法识别')
  return { entries, cdStart, cdSize }
}

/* -------------------------------- 便捷函数 ------------------------------- */

export async function openZip(filePath: string): Promise<ZipReader> {
  return ZipReader.open(filePath)
}

/** 一次性读取：打开 → 读条目 → 关闭 */
export async function readZipEntry(filePath: string, name: string): Promise<Buffer | null> {
  const zip = await ZipReader.open(filePath)
  try {
    return await zip.readEntry(name)
  } finally {
    await zip.close()
  }
}

export const ZIP_METHOD_STORE = METHOD_STORE
export const ZIP_METHOD_DEFLATE = METHOD_DEFLATE
export { FLAG_DATA_DESCRIPTOR, FLAG_ENCRYPTED }
