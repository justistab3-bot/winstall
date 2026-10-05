/**
 * axml.ts —— 二进制 AndroidManifest.xml（AXML）解析器
 *
 * 零依赖，只使用 Buffer。产出与 XML 等价的轻量 DOM：
 *   { name, attrs: Record<string, AxmlValue>, children: AxmlNode[] }
 *
 * 关键实现点：
 *  - StringPool 同时支持 UTF-8 标志 (0x100) 与 UTF-16；
 *  - 属性名优先用 ResourceMap chunk（RES_XML_RESOURCE_MAP_TYPE = 0x0180）
 *    把「字符串池下标 → android 资源 id → 规范属性名」映射出来，
 *    字符串前缀（"android:xxx"）只作为兜底；
 *  - 属性值保留类型：字符串 / 整数(十进制、十六进制) / 布尔 / 资源引用。
 */

/* --------------------------------- 常量 --------------------------------- */

const RES_STRING_POOL_TYPE = 0x0001
const RES_XML_TYPE = 0x0003
const RES_XML_START_NAMESPACE_TYPE = 0x0100
const RES_XML_END_NAMESPACE_TYPE = 0x0101
const RES_XML_START_ELEMENT_TYPE = 0x0102
const RES_XML_END_ELEMENT_TYPE = 0x0103
const RES_XML_CDATA_TYPE = 0x0104
/** 注意：资源映射表是 0x0180，不是 0x0100（0x0100 是 START_NAMESPACE） */
const RES_XML_RESOURCE_MAP_TYPE = 0x0180

const NO_ENTRY = 0xffffffff

const ANDROID_NS_URI = 'http://schemas.android.com/apk/res/android'

/* Res_value 数据类型 */
export const TYPE_NULL = 0x00
export const TYPE_REFERENCE = 0x01
export const TYPE_ATTRIBUTE = 0x02
export const TYPE_STRING = 0x03
export const TYPE_FLOAT = 0x04
export const TYPE_DIMENSION = 0x05
export const TYPE_FRACTION = 0x06
export const TYPE_DYNAMIC_REFERENCE = 0x07
export const TYPE_INT_DEC = 0x10
export const TYPE_INT_HEX = 0x11
export const TYPE_INT_BOOLEAN = 0x12
export const TYPE_INT_COLOR_ARGB8 = 0x1c
export const TYPE_INT_COLOR_RGB8 = 0x1d
export const TYPE_INT_COLOR_ARGB4 = 0x1e
export const TYPE_INT_COLOR_RGB4 = 0x1f

/* ------------------------------- 属性名映射 ------------------------------ */

/**
 * android 命名空间属性的资源 id → 规范名。
 * 这张表是「可靠来源」，字符串池里的名字只是兜底。
 */
const ANDROID_ATTR_NAMES: Readonly<Record<number, string>> = {
  0x01010000: 'theme',
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010004: 'permission',
  0x01010005: 'readPermission',
  0x01010006: 'writePermission',
  0x01010007: 'protectionLevel',
  0x01010008: 'permissionGroup',
  0x01010009: 'sharedUserId',
  0x0101000a: 'sharedUserLabel',
  0x0101000b: 'hasCode',
  0x0101000c: 'allowClearUserData',
  0x0101000d: 'enabled',
  0x0101000e: 'exported',
  0x0101000f: 'debuggable',
  0x01010010: 'process',
  0x01010011: 'taskAffinity',
  0x01010012: 'multiprocess',
  0x01010013: 'finishOnTaskLaunch',
  0x01010014: 'clearTaskOnLaunch',
  0x01010015: 'stateNotNeeded',
  0x01010016: 'excludeFromRecents',
  0x01010017: 'authorities',
  0x01010018: 'syncable',
  0x01010019: 'initOrder',
  0x0101001a: 'grantUriPermissions',
  0x0101001b: 'priority',
  0x0101001c: 'launchMode',
  0x0101001d: 'screenOrientation',
  0x0101001e: 'configChanges',
  0x0101001f: 'description',
  0x01010020: 'targetPackage',
  0x01010021: 'handleProfiling',
  0x01010022: 'functionalTest',
  0x01010023: 'value',
  0x01010024: 'resource',
  0x01010025: 'mimeType',
  0x01010026: 'scheme',
  0x01010027: 'host',
  0x01010028: 'port',
  0x01010029: 'path',
  0x0101002a: 'pathPrefix',
  0x0101002b: 'pathPattern',
  0x0101002c: 'action',
  0x0101002d: 'data',
  0x0101002e: 'targetClass',
  0x0101002f: 'colorForeground',
  0x01010030: 'colorBackground',
  0x01010031: 'fontScale',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101021e: 'installLocation',
  0x01010230: 'banner',
  0x0101026c: 'hardwareAccelerated',
  0x01010270: 'targetSdkVersion',
  0x01010271: 'maxSdkVersion',
  0x01010272: 'testOnly',
  0x01010280: 'allowBackup',
  0x010102b0: 'largeHeap',
  0x010102be: 'logo',
  0x010103af: 'supportsRtl',
  0x010104ea: 'extractNativeLibs',
  0x010104ec: 'usesCleartextTraffic',
  0x010104f6: 'resizeableActivity',
  0x01010505: 'directBootAware',
  0x01010527: 'networkSecurityConfig',
  0x0101052c: 'roundIcon',
  0x01010572: 'compileSdkVersion',
  0x01010573: 'compileSdkVersionCodename',
  0x01010576: 'versionCodeMajor',
  0x0101057a: 'appComponentFactory',
  0x01010591: 'isSplitRequired'
}

/** 按名字反查资源 id（资源映射表缺失时使用） */
const ANDROID_ATTR_IDS: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {}
  for (const [idStr, name] of Object.entries(ANDROID_ATTR_NAMES)) out[name] = Number(idStr)
  return out
})()

/* --------------------------------- 类型 --------------------------------- */

export type AxmlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number; hex: boolean }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'reference'; id: number }
  | { kind: 'attribute'; id: number }
  | { kind: 'float'; value: number }
  | { kind: 'null' }

export interface AxmlNode {
  name: string
  attrs: Record<string, AxmlValue>
  children: AxmlNode[]
}

export interface AxmlDocument {
  root: AxmlNode | null
  /** 所有元素节点（含 root），按文档顺序，便于快速查找 */
  elements: AxmlNode[]
  stringPool: string[]
}

/* ------------------------------ 取值辅助函数 ----------------------------- */

/** 取属性原始值（兼容 `android:xxx` 与 `xxx` 两种键） */
export function getAttr(node: AxmlNode, key: string): AxmlValue | undefined {
  const direct = node.attrs[key]
  if (direct !== undefined) return direct
  return node.attrs[`android:${key}`]
}

export function attrString(v: AxmlValue | undefined): string | null {
  if (!v) return null
  switch (v.kind) {
    case 'string':
      return v.value
    case 'int':
      return String(v.value)
    case 'boolean':
      return v.value ? 'true' : 'false'
    case 'reference':
    case 'attribute':
      return `@${v.id.toString(16)}`
    case 'float':
      return String(v.value)
    default:
      return null
  }
}

/** 转数字：整数 / 数字字符串 / 布尔(0|1) 都能正确转换；资源引用返回 null */
export function attrNumber(v: AxmlValue | undefined): number | null {
  if (!v) return null
  switch (v.kind) {
    case 'int':
      return v.value
    case 'float':
      return v.value
    case 'boolean':
      return v.value ? 1 : 0
    case 'string': {
      const t = v.value.trim()
      if (t === '') return null
      const n = /^0x[0-9a-f]+$/i.test(t) ? Number.parseInt(t.slice(2), 16) : Number(t)
      return Number.isFinite(n) ? n : null
    }
    default:
      return null
  }
}

export function attrBool(v: AxmlValue | undefined): boolean | null {
  if (!v) return null
  switch (v.kind) {
    case 'boolean':
      return v.value
    case 'int':
      return v.value !== 0
    case 'string': {
      const t = v.value.trim().toLowerCase()
      if (t === 'true' || t === '1') return true
      if (t === 'false' || t === '0') return false
      return null
    }
    default:
      return null
  }
}

/** 若属性是资源引用则返回资源 id（0x7f......），否则 null */
export function attrRefId(v: AxmlValue | undefined): number | null {
  if (!v) return null
  if (v.kind === 'reference' || v.kind === 'attribute') return v.id
  return null
}

/** 便利方法：直接从节点取字符串属性 */
export function nodeString(node: AxmlNode, key: string): string | null {
  return attrString(getAttr(node, key))
}

export function nodeNumber(node: AxmlNode, key: string): number | null {
  return attrNumber(getAttr(node, key))
}

export function nodeBool(node: AxmlNode, key: string): boolean | null {
  return attrBool(getAttr(node, key))
}

export function nodeRefId(node: AxmlNode, key: string): number | null {
  return attrRefId(getAttr(node, key))
}

/** 深度优先查找所有指定名字的元素 */
export function findElements(root: AxmlNode | null, name: string): AxmlNode[] {
  const out: AxmlNode[] = []
  const walk = (n: AxmlNode): void => {
    if (n.name === name) out.push(n)
    for (const c of n.children) walk(c)
  }
  if (root) walk(root)
  return out
}

/** 找第一个指定名字的元素 */
export function findElement(root: AxmlNode | null, name: string): AxmlNode | null {
  return findElements(root, name)[0] ?? null
}

/* ------------------------------ StringPool ------------------------------ */

interface StringPool {
  strings: string[]
}

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

function parseStringPool(buf: Buffer, start: number, limit: number): StringPool {
  const headerSize = buf.readUInt16LE(start + 2)
  const chunkSize = buf.readUInt32LE(start + 4)
  const chunkEnd = Math.min(start + chunkSize, limit)
  const stringCount = buf.readUInt32LE(start + 8)
  const flags = buf.readUInt32LE(start + 16)
  const stringsStart = buf.readUInt32LE(start + 20)
  const isUtf8 = (flags & 0x100) !== 0

  const offsetsBase = start + headerSize
  const dataBase = start + stringsStart
  const strings: string[] = new Array<string>(stringCount).fill('')

  for (let i = 0; i < stringCount; i++) {
    const offPos = offsetsBase + i * 4
    if (offPos + 4 > chunkEnd) break
    const offset = buf.readUInt32LE(offPos)
    if (offset === NO_ENTRY) continue
    const p = dataBase + offset
    if (p < 0 || p >= chunkEnd) continue
    try {
      if (isUtf8) {
        const l1 = decodeLength8(buf, p, chunkEnd)
        const l2 = decodeLength8(buf, l1.next, chunkEnd)
        const from = l2.next
        const to = Math.min(from + l2.len, chunkEnd)
        strings[i] = from >= to ? '' : buf.toString('utf8', from, to)
      } else {
        const l = decodeLength16(buf, p, chunkEnd)
        const from = l.next
        const to = Math.min(from + l.len * 2, chunkEnd)
        strings[i] = from >= to ? '' : buf.toString('utf16le', from, to)
      }
    } catch {
      strings[i] = ''
    }
  }
  return { strings }
}

/* ------------------------------- 主解析器 ------------------------------- */

function stripNamespacePrefix(name: string): string {
  const idx = name.indexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

function readResValue(
  buf: Buffer,
  pos: number,
  limit: number,
  pool: string[]
): AxmlValue {
  if (pos + 8 > limit) return { kind: 'null' }
  const dataType = buf.readUInt8(pos + 3)
  const data = buf.readUInt32LE(pos + 4)
  switch (dataType) {
    case TYPE_STRING:
      return { kind: 'string', value: data < pool.length ? pool[data] : '' }
    case TYPE_INT_BOOLEAN:
      return { kind: 'boolean', value: data !== 0 }
    case TYPE_INT_DEC:
      return { kind: 'int', value: data | 0, hex: false }
    case TYPE_INT_HEX:
      return { kind: 'int', value: data >>> 0, hex: true }
    case TYPE_INT_COLOR_ARGB8:
    case TYPE_INT_COLOR_RGB8:
    case TYPE_INT_COLOR_ARGB4:
    case TYPE_INT_COLOR_RGB4:
      return { kind: 'int', value: data >>> 0, hex: true }
    case TYPE_REFERENCE:
    case TYPE_DYNAMIC_REFERENCE:
      return { kind: 'reference', id: data >>> 0 }
    case TYPE_ATTRIBUTE:
      return { kind: 'attribute', id: data >>> 0 }
    case TYPE_FLOAT: {
      const tmp = Buffer.allocUnsafe(4)
      tmp.writeUInt32LE(data >>> 0, 0)
      return { kind: 'float', value: tmp.readFloatLE(0) }
    }
    default:
      return { kind: 'null' }
  }
}

/**
 * 解析 AXML。
 * @throws 当数据不是合法 AXML 时抛出（调用方需 try/catch）
 */
export function parseAxmlDocument(data: Buffer): AxmlDocument {
  if (!Buffer.isBuffer(data) || data.length < 8) throw new Error('AXML 数据过短')
  const type = data.readUInt16LE(0)
  const headerSize = data.readUInt16LE(2)
  const declaredSize = data.readUInt32LE(4)
  if (type !== RES_XML_TYPE) {
    throw new Error(`不是 AXML：chunk type=0x${type.toString(16)}`)
  }
  const total = Math.min(declaredSize > 0 ? declaredSize : data.length, data.length)
  const limit = total

  let pool: string[] = []
  let resourceMap: number[] = []
  const elements: AxmlNode[] = []
  const stack: AxmlNode[] = []
  let rootNode: AxmlNode | null = null

  let p = headerSize >= 8 ? headerSize : 8
  while (p + 8 <= limit) {
    const chunkType = data.readUInt16LE(p)
    const chunkHeaderSize = data.readUInt16LE(p + 2)
    const chunkSize = data.readUInt32LE(p + 4)
    if (chunkSize < 8 || p + chunkSize > limit) break

    switch (chunkType) {
      case RES_STRING_POOL_TYPE: {
        pool = parseStringPool(data, p, limit).strings
        break
      }
      case RES_XML_RESOURCE_MAP_TYPE: {
        const count = Math.floor((chunkSize - chunkHeaderSize) / 4)
        const arr: number[] = new Array<number>(count)
        for (let i = 0; i < count; i++) {
          const off = p + chunkHeaderSize + i * 4
          arr[i] = off + 4 <= limit ? data.readUInt32LE(off) >>> 0 : 0
        }
        resourceMap = arr
        break
      }
      case RES_XML_START_ELEMENT_TYPE: {
        const node = parseStartElement(data, p, chunkSize, limit, pool, resourceMap)
        if (node) {
          elements.push(node)
          const parent = stack.length > 0 ? stack[stack.length - 1] : undefined
          if (parent) parent.children.push(node)
          else if (!rootNode) rootNode = node
          stack.push(node)
        }
        break
      }
      case RES_XML_END_ELEMENT_TYPE: {
        stack.pop()
        break
      }
      // 以下 chunk 对 manifest 语义无影响，显式跳过
      case RES_XML_START_NAMESPACE_TYPE:
      case RES_XML_END_NAMESPACE_TYPE:
      case RES_XML_CDATA_TYPE:
      default:
        break
    }
    p += chunkSize
  }

  return { root: rootNode, elements, stringPool: pool }
}

function parseStartElement(
  buf: Buffer,
  chunkStart: number,
  chunkSize: number,
  limit: number,
  pool: string[],
  resourceMap: number[]
): AxmlNode | null {
  const chunkEnd = Math.min(chunkStart + chunkSize, limit)
  // ResXMLTree_node: header(8) + lineNumber(4) + comment(4) = 16
  const ext = chunkStart + 16
  if (ext + 20 > chunkEnd) return null
  const nameIndex = buf.readUInt32LE(ext + 4)
  const attributeStart = buf.readUInt16LE(ext + 8)
  const attributeSize = buf.readUInt16LE(ext + 10)
  const attributeCount = buf.readUInt16LE(ext + 12)

  const name = nameIndex < pool.length ? pool[nameIndex] : ''
  const attrs: Record<string, AxmlValue> = {}
  const attrBase = ext + attributeStart
  const step = attributeSize >= 20 ? attributeSize : 20

  for (let i = 0; i < attributeCount; i++) {
    const a = attrBase + i * step
    if (a + 20 > chunkEnd) break
    const nsIndex = buf.readUInt32LE(a)
    const attrNameIndex = buf.readUInt32LE(a + 4)
    const rawValueIndex = buf.readUInt32LE(a + 8)
    const typed = readResValue(buf, a + 12, chunkEnd, pool)

    const rawName = attrNameIndex < pool.length ? pool[attrNameIndex] : ''
    const nsUri = nsIndex !== NO_ENTRY && nsIndex < pool.length ? pool[nsIndex] : ''
    const namespaced = nsUri.length > 0

    // 1) 资源映射表（最可靠）
    let resId = 0
    if (attrNameIndex < resourceMap.length) resId = resourceMap[attrNameIndex] >>> 0
    if (resId === 0 && rawName) {
      const guess = ANDROID_ATTR_IDS[stripNamespacePrefix(rawName)]
      if (guess !== undefined) resId = guess
    }
    let canonical = resId !== 0 ? ANDROID_ATTR_NAMES[resId] : undefined
    if (!canonical) {
      canonical = rawName ? stripNamespacePrefix(rawName) : ''
      if (!canonical && resId !== 0) canonical = `attr_0x${resId.toString(16)}`
    }
    if (!canonical) continue

    // 2) 取值：优先 typedValue；typed 为 null 时退回 rawValue 字符串
    let value: AxmlValue = typed
    if (value.kind === 'null' && rawValueIndex !== NO_ENTRY && rawValueIndex < pool.length) {
      value = { kind: 'string', value: pool[rawValueIndex] }
    }

    attrs[canonical] = value
    if (namespaced && nsUri === ANDROID_NS_URI) attrs[`android:${canonical}`] = value
  }

  return { name, attrs, children: [] }
}

/** 常用入口：直接拿到根节点 */
export function parseAxml(data: Buffer): AxmlNode {
  const doc = parseAxmlDocument(data)
  if (!doc.root) throw new Error('AXML 中没有找到根元素')
  return doc.root
}

/* ------------------------------ 高层语义辅助 ----------------------------- */

/** 判断 intent-filter 是否包含指定 action / category */
function intentFilterHas(node: AxmlNode, childName: string, attrName: string, want: string): boolean {
  for (const child of node.children) {
    if (child.name !== childName) continue
    const v = nodeString(child, attrName)
    if (v === want) return true
  }
  return false
}

/**
 * 找出 LAUNCHER 主 Activity：
 * activity / activity-alias 下存在 intent-filter(action=MAIN 且 category=LAUNCHER)
 * 返回 android:name（可能带包名前缀，未做补全）。
 */
export function findLaunchableActivity(root: AxmlNode | null): string | null {
  if (!root) return null
  const app = findElement(root, 'application')
  if (!app) return null
  for (const node of app.children) {
    if (node.name !== 'activity' && node.name !== 'activity-alias') continue
    const name = nodeString(node, 'name')
    if (!name) continue
    for (const filter of node.children) {
      if (filter.name !== 'intent-filter') continue
      if (
        intentFilterHas(filter, 'action', 'name', 'android.intent.action.MAIN') &&
        intentFilterHas(filter, 'category', 'name', 'android.intent.category.LAUNCHER')
      ) {
        return name
      }
    }
  }
  return null
}

/** manifest 根节点的 package / split 等非命名空间属性（快捷读取） */
export interface ManifestSummary {
  packageName: string | null
  versionCode: number | null
  versionName: string | null
  compileSdk: number | null
  minSdk: number | null
  targetSdk: number | null
  appLabel: AxmlValue | null
  appIcon: AxmlValue | null
  roundIcon: AxmlValue | null
  debuggable: boolean
  testOnly: boolean
  isSplitRequired: boolean
  split: string | null
  permissions: string[]
  launchableActivity: string | null
  /** 原始属性值，供上层在「数字取不到」时走资源引用解析 */
  versionCodeValue: AxmlValue | null
  minSdkValue: AxmlValue | null
  targetSdkValue: AxmlValue | null
}

/** 把 AXML DOM 归纳成 manifest 语义摘要 */
export function summarizeManifest(root: AxmlNode): ManifestSummary {
  const app = findElement(root, 'application')
  const usesSdk = findElement(root, 'uses-sdk')

  const versionCodeMinor = nodeNumber(root, 'versionCode')
  const versionCodeMajor = nodeNumber(root, 'versionCodeMajor')
  let versionCode: number | null = null
  if (versionCodeMajor !== null && versionCodeMinor !== null) {
    // 需求：保持简单，取低 32 位
    versionCode = versionCodeMinor >>> 0
  } else {
    versionCode = versionCodeMinor
  }

  const permissions: string[] = []
  for (const p of findElements(root, 'uses-permission')) {
    const n = nodeString(p, 'name')
    if (n) permissions.push(n)
  }

  const labelVal = app ? getAttr(app, 'label') ?? null : null
  const iconVal = app ? getAttr(app, 'icon') ?? null : null
  const roundVal = app ? getAttr(app, 'roundIcon') ?? null : null

  return {
    packageName: nodeString(root, 'package'),
    versionCode,
    versionName: nodeString(root, 'versionName'),
    compileSdk: nodeNumber(root, 'compileSdkVersion'),
    minSdk: usesSdk ? nodeNumber(usesSdk, 'minSdkVersion') : null,
    targetSdk: usesSdk ? nodeNumber(usesSdk, 'targetSdkVersion') : null,
    appLabel: labelVal,
    appIcon: iconVal,
    roundIcon: roundVal,
    debuggable: (app ? nodeBool(app, 'debuggable') : null) ?? false,
    testOnly: (app ? nodeBool(app, 'testOnly') : null) ?? false,
    isSplitRequired: (app ? nodeBool(app, 'isSplitRequired') : null) ?? false,
    split: nodeString(root, 'split'),
    permissions,
    launchableActivity: findLaunchableActivity(root),
    versionCodeValue: getAttr(root, 'versionCode') ?? null,
    minSdkValue: usesSdk ? getAttr(usesSdk, 'minSdkVersion') ?? null : null,
    targetSdkValue: usesSdk ? getAttr(usesSdk, 'targetSdkVersion') ?? null : null
  }
}
