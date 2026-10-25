import type { BundleKind, SplitApk, SplitKind } from './types'

/**
 * 分包（split APK）分类与选择 —— 纯逻辑，主进程与渲染层共用。
 *
 * 一个 `.apks` / `.xapk` 里通常包含：
 *   base.apk                        主体
 *   split_config.arm64_v8a.apk      ABI 分包（每个架构一个）
 *   split_config.xxhdpi.apk         密度分包
 *   split_config.zh.apk             语言分包
 *   split_config.astc.apk           纹理压缩格式分包
 *
 * 安装时必须把「base + 与当前设备匹配的配置分包」一起装，
 * 尤其 ABI 分包：给 32 位设备装 arm64 分包会直接失败。
 */

/** 各渠道的分包命名差异很大，这里统一归一化到 Android 的 ABI 名 */
const ABI_MAP: Record<string, string> = {
  arm64_v8a: 'arm64-v8a',
  arm64v8a: 'arm64-v8a',
  armeabi_v7a: 'armeabi-v7a',
  armeabiv7a: 'armeabi-v7a',
  armeabi: 'armeabi',
  x86_64: 'x86_64',
  x86: 'x86',
  mips64: 'mips64',
  mips: 'mips',
  riscv64: 'riscv64'
}

const DENSITY_DPI: Record<string, number> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640
}

/** nodpi / anydpi 不是真实密度，任何设备都该带上 */
const DENSITY_ALWAYS = new Set(['nodpi', 'anydpi'])

const TEXTURE_TOKENS = new Set(['astc', 'etc2', 'etc1', 'pvrtc', 's3tc', '3dflex'])

/** 把 arm64_v8a 之类的写法归一化成 arm64-v8a */
export function normalizeAbiToken(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/[-.\s]/g, '_')
  return ABI_MAP[t] ?? null
}

/** 语言标签：2 位 ISO 639-1、lang_REGION、或 bundletool 的 b+xx+YYY 形式 */
function isLanguageToken(token: string): boolean {
  const t = token.trim()
  if (/^[a-z]{2}$/i.test(t)) return true
  if (/^[a-z]{2}[_-][a-z]{2}$/i.test(t)) return true
  if (/^[a-z]{2}[_-]\d{3}$/i.test(t)) return true
  if (/^b\+[a-z]{2,3}(\+[a-z0-9]{2,8})*$/i.test(t)) return true
  return false
}

/** 从文件名里剥出「配置标识」候选，按可信度排序 */
function configCandidates(entryName: string): string[] {
  const base = (entryName.split('/').pop() ?? entryName).replace(/\.apk$/i, '')
  const out: string[] = []

  // bundletool 的功能模块命名：<module>.config.<config>
  // 例如 split_delivery.config.arm64_v8a → arm64_v8a
  //
  // 只有当倒数第二段确实是 "config" 时才取最后一段 ——
  // 否则 "com.tencent.mm" 这类「用包名命名的 base」会被误判成语言分包（mm 正好是 2 个字母）。
  const dotParts = base.split('.')
  if (dotParts.length >= 3 && /^config$/i.test(dotParts[dotParts.length - 2] ?? '')) {
    const last = dotParts[dotParts.length - 1]
    if (last) out.push(last)
  }

  // split_config.arm64_v8a / config.arm64_v8a / split_arm64_v8a
  const prefixed = /^(?:split_config|config|split)[._](.+)$/i.exec(base)
  if (prefixed) out.push(prefixed[1])

  // base-arm64_v8a（bundletool 的另一种命名）
  const baseDash = /^base[-.](.+)$/i.exec(base)
  if (baseDash) out.push(baseDash[1])

  // 兜底：最后一个 '-' 之后
  const dash = base.lastIndexOf('-')
  if (dash > 0 && dash < base.length - 1) out.push(base.slice(dash + 1))

  // 再兜底：整体
  out.push(base)
  return out
}

/** 判断一个条目是不是 base（主体）分包 */
function isBaseName(entryName: string): boolean {
  const base = (entryName.split('/').pop() ?? entryName).replace(/\.apk$/i, '').toLowerCase()
  return base === 'base' || base === 'base-master' || base.endsWith('-master') || base === 'master'
}

export interface SplitClass {
  kind: SplitKind
  config: string | null
  abi: string | null
}

/** 根据条目名判断分包作用 */
export function classifySplit(entryName: string): SplitClass {
  if (isBaseName(entryName)) return { kind: 'base', config: null, abi: null }

  for (const raw of configCandidates(entryName)) {
    const token = raw.trim()

    const abi = normalizeAbiToken(token)
    if (abi) return { kind: 'abi', config: raw, abi }

    const lower = token.toLowerCase().replace(/[-.]/g, '_')
    if (DENSITY_DPI[lower] != null || DENSITY_ALWAYS.has(lower)) {
      return { kind: 'density', config: raw, abi: null }
    }
    if (TEXTURE_TOKENS.has(lower)) return { kind: 'texture', config: raw, abi: null }
    if (isLanguageToken(token)) return { kind: 'language', config: raw, abi: null }
  }

  return { kind: 'other', config: null, abi: null }
}

/** 根据扩展名 + ZIP 内容判断容器类型 */
export function detectBundleKind(filePath: string, entryNames: string[]): BundleKind {
  const lower = filePath.toLowerCase()
  const has = (name: string) => entryNames.some((e) => e.toLowerCase() === name)
  const hasSuffix = (suffix: string) => entryNames.some((e) => e.toLowerCase().endsWith(suffix))

  if (lower.endsWith('.xapk')) return 'xapk'
  if (lower.endsWith('.apkm')) return 'apkm'
  if (lower.endsWith('.apks')) return 'apks'

  // 扩展名不认识时看内容
  if (has('toc.pb')) return 'apks'
  if (has('manifest.json')) return 'xapk'
  if (has('info.json')) return 'apkm'
  if (hasSuffix('.apk')) return 'apks'
  return 'apk'
}

/** 扩展名是否是分包容器 */
export function isBundleExtension(filePath: string): boolean {
  return /\.(apks|xapk|apkm)$/i.test(filePath)
}

export interface SplitSelectContext {
  /** 设备支持的 ABI 列表，如 ['arm64-v8a','armeabi-v7a'] */
  abiList: string[]
  /** 设备屏幕密度（dpi），未知时传 null */
  densityDpi?: number | null
  /** 设备语言，如 'zh-CN'，未知时传 null */
  locale?: string | null
}

export interface SplitSelection {
  splits: SplitApk[]
  /** 选中的 ABI 分包对应哪个 ABI（没有 ABI 分包时为 null） */
  matchedAbi: string | null
  /** 致命错误 */
  error: string | null
  warning: string | null
}

/**
 * 按设备能力挑选要安装的分包。
 *
 * - base：必选
 * - ABI：只保留设备支持的；一个都不匹配就是致命错误
 * - 密度：选最接近设备 dpi 的那个（nodpi/anydpi 始终保留）；不知道 dpi 就全保留
 * - 语言：选设备语言 + 英语；不知道语言就全保留
 * - 纹理 / 其他：全保留（体积小，系统会自己挑）
 */
export function selectSplits(all: SplitApk[], ctx: SplitSelectContext): SplitSelection {
  const deviceAbis = new Set(ctx.abiList.map((a) => a.toLowerCase()))
  const out: SplitApk[] = []
  let matchedAbi: string | null = null
  let error: string | null = null
  let warning: string | null = null

  const abiSplits = all.filter((s) => s.kind === 'abi')

  // ABI：必须至少有一个匹配，否则装上去也跑不起来
  if (abiSplits.length > 0) {
    const matching = abiSplits.filter((s) => s.abi && deviceAbis.has(s.abi.toLowerCase()))
    if (matching.length === 0) {
      const have = abiSplits.map((s) => s.abi).filter(Boolean).join('、')
      const dev = ctx.abiList.join('、') || '未知'
      error = `这个安装包只提供了 ${have} 的架构分包，而当前设备支持 ${dev}，没有可用的分包`
    } else {
      // 有多匹配时优先 64 位
      matching.sort((a, b) => rankAbi(a.abi) - rankAbi(b.abi))
      matchedAbi = matching[0].abi
    }
  }

  // 密度：挑最接近的
  const densitySplits = all.filter((s) => s.kind === 'density')
  let chosenDensity: string | null = null
  if (densitySplits.length > 0 && ctx.densityDpi && ctx.densityDpi > 0) {
    let best = Infinity
    for (const s of densitySplits) {
      const key = (s.config ?? '').toLowerCase().replace(/[-.]/g, '_')
      if (DENSITY_ALWAYS.has(key)) continue
      const dpi = DENSITY_DPI[key]
      if (dpi == null) continue
      const dist = Math.abs(dpi - ctx.densityDpi)
      if (dist < best) {
        best = dist
        chosenDensity = s.config
      }
    }
  }

  // 语言：设备语言 + 英语
  const deviceLang = (ctx.locale ?? '').split(/[-_]/)[0]?.toLowerCase() || null
  const wantLangs = new Set<string>()
  if (deviceLang) {
    wantLangs.add(deviceLang)
    wantLangs.add('en')
  }

  for (const s of all) {
    let keep = false
    switch (s.kind) {
      case 'base':
        keep = true
        break
      case 'abi':
        keep = !!s.abi && s.abi === matchedAbi
        break
      case 'density': {
        const key = (s.config ?? '').toLowerCase().replace(/[-.]/g, '_')
        if (DENSITY_ALWAYS.has(key)) keep = true
        else keep = chosenDensity == null ? true : s.config === chosenDensity
        break
      }
      case 'language': {
        if (wantLangs.size === 0) {
          keep = true
          break
        }
        const code = (s.config ?? '').toLowerCase().split(/[-_+]/).filter(Boolean)[0] ?? ''
        keep = wantLangs.has(code)
        // 一个都不留会出问题，交给下面兜底
        break
      }
      default:
        keep = true
    }
    out.push({ ...s, selected: keep })
  }

  // 兜底：如果语言分包一个都没选中，全带上（宁可多传也不能缺资源）
  const langSplits = out.filter((s) => s.kind === 'language')
  if (langSplits.length > 0 && !langSplits.some((s) => s.selected)) {
    for (const s of out) if (s.kind === 'language') s.selected = true
    warning = '未能匹配设备语言，已包含全部语言分包'
  }

  // 没有任何 base 是致命的
  if (!out.some((s) => s.kind === 'base')) {
    error = error ?? '这个包里找不到 base 分包（可能是纯配置分包），无法安装'
  }

  const selectedCount = out.filter((s) => s.selected).length
  if (!warning && selectedCount < out.length) {
    warning = null
  }

  return { splits: out, matchedAbi, error, warning }
}

function rankAbi(abi: string | null): number {
  const order = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'mips64', 'mips', 'riscv64']
  const i = order.indexOf(abi ?? '')
  return i < 0 ? 99 : i
}

/** 汇总选中的分包体积 */
export function summarizeSelection(splits: SplitApk[]): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const s of splits) {
    if (!s.selected) continue
    count++
    bytes += s.rawSize
  }
  return { count, bytes }
}
