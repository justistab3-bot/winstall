import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { classifySplit, detectBundleKind } from '../../shared/bundle'
import type { BundleKind, SplitApk } from '../../shared/types'
import { ZipReader } from './zip'

export interface BundleScan {
  kind: BundleKind
  splits: SplitApk[]
  /** base 分包在 ZIP 里的条目名 */
  baseEntry: string | null
  /** 需要额外推送到 /sdcard/Android/obb/<包名>/ 的条目名 */
  obbEntries: string[]
  /** XAPK/APKM 清单里声明的包名（作为解析 base 失败时的兜底） */
  manifestPackage: string | null
  error: string | null
}

/** XAPK 的 manifest.json / APKM 的 info.json 结构（只取用得到的字段） */
interface BundleManifest {
  package_name?: string
  name?: string
  version_code?: string | number
  version_name?: string
  min_sdk_version?: string | number
  target_sdk_version?: string | number
  split_apks?: Array<{ file?: string; id?: string }>
  split_apk_list?: Array<{ file?: string; id?: string }>
}

/**
 * 读取 XAPK/APKM 的清单文件。
 * 清单里的 `split_apks[].id` 是权威的分包标识（base / config.arm64_v8a），
 * 比按文件名猜可靠得多 —— 有些 XAPK 的 base 就叫 `<包名>.apk`。
 */
async function readManifest(reader: ZipReader): Promise<BundleManifest | null> {
  for (const name of ['manifest.json', 'info.json']) {
    try {
      const buf = await reader.readEntry(name)
      if (!buf) continue
      const parsed = JSON.parse(buf.toString('utf8')) as BundleManifest
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

/**
 * 只读中央目录，不解压。
 * 拿到分包清单、体积、以及每个分包的作用（base / abi / density / language / ...）。
 */
export async function scanBundle(filePath: string): Promise<BundleScan> {
  let reader: ZipReader | null = null
  try {
    reader = await ZipReader.open(filePath)
    const entries = reader.listEntries()
    const names = entries.map((e) => e.fileName)
    const kind = detectBundleKind(filePath, names)

    const apkEntries = entries.filter((e) => !e.isDirectory && /\.apk$/i.test(e.fileName))
    const obbEntries = entries
      .filter((e) => !e.isDirectory && /\.obb$/i.test(e.fileName))
      .map((e) => e.fileName)

    if (apkEntries.length === 0) {
      return {
        kind,
        splits: [],
        baseEntry: null,
        obbEntries,
        manifestPackage: null,
        error: '这个压缩包里没有任何 .apk 文件'
      }
    }

    // XAPK / APKM：优先用清单里的 id 来判定每个 APK 的角色
    const manifest = kind === 'xapk' || kind === 'apkm' ? await readManifest(reader) : null
    const declared = new Map<string, string>()
    for (const item of manifest?.split_apks ?? manifest?.split_apk_list ?? []) {
      if (!item?.file || !item?.id) continue
      declared.set(item.file.toLowerCase(), item.id)
      declared.set((item.file.split('/').pop() ?? '').toLowerCase(), item.id)
    }

    const splits: SplitApk[] = apkEntries.map((e) => {
      const short = (e.fileName.split('/').pop() ?? '').toLowerCase()
      const declaredId = declared.get(e.fileName.toLowerCase()) ?? declared.get(short)

      // 清单里写的是 "base" 或 "config.arm64_v8a"，喂给分类器即可复用同一套规则
      const c = declaredId ? classifySplit(`${declaredId}.apk`) : classifySplit(e.fileName)
      return {
        entryName: e.fileName,
        size: e.compressedSize,
        rawSize: e.uncompressedSize,
        kind: c.kind,
        config: c.config,
        abi: c.abi,
        selected: false
      }
    })

    // base 兜底：命名不规范时，把体积最大的那个当 base
    let baseEntry = splits.find((s) => s.kind === 'base')?.entryName ?? null
    if (!baseEntry) {
      const biggest = [...splits].sort((a, b) => b.rawSize - a.rawSize)[0]
      if (biggest) {
        baseEntry = biggest.entryName
        const idx = splits.findIndex((s) => s.entryName === biggest.entryName)
        if (idx >= 0) splits[idx] = { ...splits[idx], kind: 'base' }
      }
    }

    return {
      kind,
      splits,
      baseEntry,
      obbEntries,
      manifestPackage: manifest?.package_name ?? null,
      error: null
    }
  } catch (err) {
    return {
      kind: 'apks',
      splits: [],
      baseEntry: null,
      obbEntries: [],
      manifestPackage: null,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    await reader?.close().catch(() => undefined)
  }
}

/**
 * 解压器：保持 ZIP 句柄打开，按需把条目解压到目标目录。
 * 用于「解析时只解 base」和「安装时只解选中的分包」两种场景。
 */
export class BundleExtractor {
  private constructor(
    private readonly reader: ZipReader,
    readonly destDir: string
  ) {}

  static async open(filePath: string, destDir: string): Promise<BundleExtractor> {
    mkdirSync(destDir, { recursive: true })
    const reader = await ZipReader.open(filePath)
    return new BundleExtractor(reader, destDir)
  }

  /**
   * 解压一个条目，返回本地文件路径。
   * 走流式解压 —— base.apk 可能有几百 MB，不能整个读进内存。
   */
  async extract(entryName: string, outName?: string): Promise<string> {
    const entry = this.reader.getEntry(entryName)
    if (!entry) throw new Error(`压缩包内找不到 ${entryName}`)

    // 条目名可能带目录，输出时只保留安全字符
    const safe = (outName ?? (entryName.split('/').pop() ?? 'entry')).replace(/[^\w.\-]/g, '_')
    const dest = path.join(this.destDir, safe)
    await this.reader.extractToFile(entryName, dest)
    return dest
  }

  async close(): Promise<void> {
    await this.reader.close().catch(() => undefined)
  }

  /** 关闭并删掉整个临时目录 */
  async dispose(): Promise<void> {
    await this.close()
    try {
      rmSync(this.destDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/** 扩展名判断：是不是分包容器 */
export function isBundlePath(filePath: string): boolean {
  return /\.(apks|xapk|apkm)$/i.test(filePath)
}
