/**
 * 分包（.apks / .xapk）支持验证。
 *
 *   npx tsx scripts/bundle-test.ts "D:\微信_8.0.79.apks"
 *
 * 不传参数时只跑分类与选择的纯逻辑用例。
 */
import path from 'node:path'
import { classifySplit, detectBundleKind, selectSplits } from '../src/shared/bundle'
import type { SplitApk } from '../src/shared/types'

let failures = 0

function check(label: string, ok: boolean, extra = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`)
}

function split(entryName: string, rawSize = 1000): SplitApk {
  const c = classifySplit(entryName)
  return { entryName, size: rawSize, rawSize, kind: c.kind, config: c.config, abi: c.abi, selected: false }
}

/* ------------------------------------------------------------------ */
/* 1. 分类器                                                           */
/* ------------------------------------------------------------------ */

function testClassifier(): void {
  section('1. 分包命名分类')

  const cases: Array<[string, string, string | null]> = [
    // [条目名, 期望 kind, 期望 abi]
    ['base.apk', 'base', null],
    ['base-master.apk', 'base', null],
    ['split_config.arm64_v8a.apk', 'abi', 'arm64-v8a'],
    ['split_config.armeabi_v7a.apk', 'abi', 'armeabi-v7a'],
    ['split_config.x86_64.apk', 'abi', 'x86_64'],
    ['split_config.xxhdpi.apk', 'density', null],
    ['split_config.zh.apk', 'language', null],
    ['split_config.zh_CN.apk', 'language', null],
    ['split_config.en.apk', 'language', null],
    ['split_config.astc.apk', 'texture', null],
    // 功能模块分包（真实 WeChat 包里的命名）
    ['split_delivery.apk', 'other', null],
    ['split_delivery.config.arm64_v8a.apk', 'abi', 'arm64-v8a'],
    // 旧式命名
    ['base-arm64_v8a.apk', 'abi', 'arm64-v8a'],
    ['config.armeabi_v7a.apk', 'abi', 'armeabi-v7a'],
    // XAPK 常见命名
    ['com.tencent.mm.apk', 'other', null],
    ['config.xxhdpi.apk', 'density', null]
  ]

  for (const [name, kind, abi] of cases) {
    const c = classifySplit(name)
    const ok = c.kind === kind && (abi == null || c.abi === abi)
    check(`${name} → ${c.kind}${c.abi ? ` (${c.abi})` : ''}`, ok, ok ? '' : `期望 ${kind}${abi ? ` (${abi})` : ''}`)
  }
}

/* ------------------------------------------------------------------ */
/* 2. 选择逻辑                                                         */
/* ------------------------------------------------------------------ */

function testSelection(): void {
  section('2. 按设备选择分包')

  const wechat = [
    split('base.apk', 208),
    split('split_config.arm64_v8a.apk', 143),
    split('split_config.xxhdpi.apk', 0.67),
    split('split_config.zh.apk', 2),
    split('split_delivery.apk', 22),
    split('split_delivery.config.arm64_v8a.apk', 33)
  ]

  // 64 位 + 480dpi + 中文
  const dev64 = { abiList: ['arm64-v8a', 'armeabi-v7a'], densityDpi: 480, locale: 'zh-CN' }
  const s64 = selectSplits(wechat, dev64)
  const picked64 = s64.splits.filter((s) => s.selected)
  check('64 位设备无致命错误', s64.error == null, s64.error ?? '')
  check('64 位设备选中全部 6 个分包', picked64.length === 6, `实际 ${picked64.length}`)
  check('64 位设备匹配到 arm64-v8a', s64.matchedAbi === 'arm64-v8a', String(s64.matchedAbi))

  // 32 位设备：这个包只有 arm64 分包，必须报错而不是硬装
  const dev32 = { abiList: ['armeabi-v7a', 'armeabi'], densityDpi: 320, locale: 'zh-CN' }
  const s32 = selectSplits(wechat, dev32)
  check('32 位设备应报「架构不匹配」', s32.error != null, s32.error ?? '(未报错)')

  // 多 ABI 的包在 32 位设备上应只挑 32 位
  const multi = [
    split('base.apk'),
    split('split_config.arm64_v8a.apk'),
    split('split_config.armeabi_v7a.apk'),
    split('split_config.x86_64.apk'),
    split('split_config.x86.apk')
  ]
  const sMulti = selectSplits(multi, dev32)
  const pickedMulti = sMulti.splits.filter((s) => s.selected)
  check('多 ABI 包在 32 位设备上只选 base + armeabi-v7a', pickedMulti.length === 2, `实际 ${pickedMulti.length}`)
  check('匹配到 armeabi-v7a', sMulti.matchedAbi === 'armeabi-v7a', String(sMulti.matchedAbi))

  // 密度：480dpi 设备应挑 xxhdpi 而不是 hdpi
  const dens = [
    split('base.apk'),
    split('split_config.ldpi.apk'),
    split('split_config.hdpi.apk'),
    split('split_config.xxhdpi.apk'),
    split('split_config.xxxhdpi.apk')
  ]
  const sDens = selectSplits(dens, { abiList: ['arm64-v8a'], densityDpi: 480, locale: 'zh-CN' })
  const pickedDens = sDens.splits.filter((s) => s.selected).map((s) => s.config)
  check('480dpi 设备只挑 xxhdpi', pickedDens.includes('xxhdpi') && !pickedDens.includes('hdpi'), pickedDens.join(','))
  check('nodpi/anydpi 始终保留', (() => {
    const withAny = [...dens, split('split_config.anydpi.apk')]
    const r = selectSplits(withAny, { abiList: ['arm64-v8a'], densityDpi: 480, locale: 'zh-CN' })
    return r.splits.some((s) => s.config === 'anydpi' && s.selected)
  })())

  // 语言：zh-CN 设备应挑 zh + en，不挑 fr
  const langs = [
    split('base.apk'),
    split('split_config.zh.apk'),
    split('split_config.en.apk'),
    split('split_config.fr.apk'),
    split('split_config.ja.apk')
  ]
  const sLang = selectSplits(langs, { abiList: ['arm64-v8a'], densityDpi: 480, locale: 'zh-CN' })
  const pickedLang = sLang.splits.filter((s) => s.selected && s.kind === 'language').map((s) => s.config)
  check('zh-CN 设备挑 zh + en', pickedLang.includes('zh') && pickedLang.includes('en'), pickedLang.join(','))
  check('zh-CN 设备不挑 fr/ja', !pickedLang.includes('fr') && !pickedLang.includes('ja'), pickedLang.join(','))

  // 缺 base 应报错
  const noBase = [split('split_config.arm64_v8a.apk')]
  const sNoBase = selectSplits(noBase, dev64)
  check('缺少 base 应报错', sNoBase.error != null, sNoBase.error ?? '(未报错)')

  // 扩展名识别
  check('.apks 识别为 apks', detectBundleKind('a.apks', []) === 'apks')
  check('.xapk 识别为 xapk', detectBundleKind('a.xapk', []) === 'xapk')
  check('toc.pb 内容识别为 apks', detectBundleKind('a.zip', ['toc.pb']) === 'apks')
  check('manifest.json 内容识别为 xapk', detectBundleKind('a.zip', ['manifest.json']) === 'xapk')
}

/* ------------------------------------------------------------------ */
/* 3. 真实文件                                                         */
/* ------------------------------------------------------------------ */

async function testRealFile(filePath: string): Promise<void> {
  section(`3. 真实分包容器：${path.basename(filePath)}`)

  const { scanBundle } = await import('../src/main/apk/bundle')
  const { parseApk } = await import('../src/main/apk')
  const { statSync } = await import('node:fs')

  const sizeMB = Math.round(statSync(filePath).size / 1024 / 1024)
  console.log(`  文件大小 ${sizeMB} MB`)

  const scan = await scanBundle(filePath)
  check('扫描无错误', scan.error == null, scan.error ?? '')
  check(`识别为 ${path.extname(filePath).slice(1)} 容器`, scan.kind === path.extname(filePath).slice(1), scan.kind)
  check('找到 base 分包', !!scan.baseEntry, String(scan.baseEntry))
  check(
    'base 分包被标记为 base',
    scan.splits.some((s) => s.kind === 'base'),
    scan.splits.find((s) => s.kind === 'base')?.entryName ?? '(无)'
  )

  console.log(`\n  共 ${scan.splits.length} 个分包：`)
  for (const s of scan.splits) {
    console.log(
      `    ${s.entryName.padEnd(38)} ${String(Math.round(s.rawSize / 1024 / 1024)).padStart(4)}MB  ` +
        `kind=${s.kind}${s.abi ? ` abi=${s.abi}` : ''}${s.config ? ` config=${s.config}` : ''}`
    )
  }
  if (scan.obbEntries.length > 0) {
    console.log(`  OBB 数据 ${scan.obbEntries.length} 个：${scan.obbEntries.join(', ')}`)
  }

  // 真实 WeChat 包里的两个关键命名（其他文件跳过）
  const deliveryAbi = scan.splits.find((s) => s.entryName === 'split_delivery.config.arm64_v8a.apk')
  if (deliveryAbi) {
    check(
      'split_delivery.config.arm64_v8a 被识别为 abi 分包',
      deliveryAbi.kind === 'abi' && deliveryAbi.abi === 'arm64-v8a',
      `${deliveryAbi.kind} / ${deliveryAbi.abi}`
    )
    const deliveryMain = scan.splits.find((s) => s.entryName === 'split_delivery.apk')
    check('split_delivery 被识别为功能分包（other）', deliveryMain?.kind === 'other', String(deliveryMain?.kind))
  }

  // 32 位设备必须被拦下（前提是这个包确实只有 64 位分包）
  const has32 = scan.splits.some((s) => s.kind === 'abi' && s.abi && !/64/.test(s.abi))
  const has64 = scan.splits.some((s) => s.kind === 'abi' && s.abi && /64/.test(s.abi))
  if (has64 && !has32) {
    const s32 = selectSplits(scan.splits, { abiList: ['armeabi-v7a', 'armeabi'], densityDpi: 320, locale: 'zh-CN' })
    check('32 位设备被正确拦下（包内只有 64 位分包）', s32.error != null, s32.error ?? '(未报错)')
  } else {
    console.log(`  ℹ 包内含 32 位分包（has32=${has32}），跳过「32 位设备拦下」断言`)
  }

  // 64 位设备：除了「不匹配的 ABI 分包」之外都应选中
  const s64 = selectSplits(scan.splits, { abiList: ['arm64-v8a', 'armeabi-v7a'], densityDpi: 480, locale: 'zh-CN' })
  const picked = s64.splits.filter((s) => s.selected)
  const expected = scan.splits.filter(
    (s) => !(s.kind === 'abi' && s.abi && s.abi !== 'arm64-v8a')
  ).length
  check(
    '64 位设备选中 base + 匹配的 ABI + 密度 + 语言',
    picked.length === expected,
    `${picked.length}/${scan.splits.length}（期望 ${expected}）`
  )

  // 解析 base 元信息（会解压 208MB，稍慢）
  console.log('\n  正在解析 base 分包（需要解压，可能较慢）…')
  const t0 = Date.now()
  const info = await parseApk(filePath)
  const elapsed = Date.now() - t0
  console.log(`    包名 ${info.packageName}`)
  console.log(`    版本 ${info.versionName} (${info.versionCode})`)
  console.log(`    应用名 ${info.appLabel}`)
  console.log(`    minSdk ${info.minSdk} / targetSdk ${info.targetSdk}`)
  console.log(`    图标 ${info.iconDataUrl ? `${Math.round(info.iconDataUrl.length / 1024)}KB` : '无'}`)
  console.log(`    容器 ${info.bundleKind} / 分包 ${info.bundle?.splits.length ?? 0} 个`)
  console.log(`    耗时 ${elapsed}ms`)

  check('解析出包名', !!info.packageName, String(info.packageName))
  check('解析出应用名', !!info.appLabel, String(info.appLabel))
  check('解析出 minSdk', info.minSdk != null, String(info.minSdk))
  check('parseError 为空', info.parseError == null, info.parseError ?? '')
  check('bundleKind 与扩展名一致', info.bundleKind === path.extname(filePath).slice(1), info.bundleKind)
  check('bundle 分包清单非空', (info.bundle?.splits.length ?? 0) > 0, String(info.bundle?.splits.length))
  // 图标不是所有 APK 都有（有些用 framework 资源），只作提示不算失败
  console.log(`  ℹ 图标：${info.iconDataUrl ? '已解析' : '该 APK 无自有图标（使用系统占位）'}`)
}

/* ------------------------------------------------------------------ */
/* 4. 大条目流式解压（回归：旧实现有 256MB 上限）                        */
/* ------------------------------------------------------------------ */

function crc32(buf: Buffer): number {
  let table = crc32.table
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    crc32.table = table
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace crc32 {
  let table: Int32Array | undefined
}

/** 最小 ZIP 写入器（仅 STORE，足够构造测试样本） */
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // STORE
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10) // STORE
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + e.data.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cd, eocd])
}

async function testLargeEntry(): Promise<void> {
  section('4. 大条目流式解压（回归：旧实现硬上限 256MB）')

  const { mkdtempSync, rmSync, statSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { ZipReader } = await import('../src/main/apk/zip')

  // 300MB —— 故意超过旧实现里 MAX_ENTRY_SIZE = 256MB 的上限
  const SIZE = 300 * 1024 * 1024
  const dir = mkdtempSync(`${tmpdir()}\\winstall-zip-test-`)
  const zipPath = `${dir}\\large.zip`
  const outPath = `${dir}\\large.bin`

  try {
    // 用一段可复现的填充数据，而不是全零（全零会让 CRC 校验失去意义）
    const chunk = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 0xff
    const parts: Buffer[] = []
    for (let i = 0; i < SIZE / chunk.length; i++) parts.push(chunk)
    writeFileSync(zipPath, buildStoredZip([{ name: 'base.apk', data: Buffer.concat(parts) }]))
    parts.length = 0

    const reader = await ZipReader.open(zipPath)
    const written = await reader.extractToFile('base.apk', outPath)
    await reader.close()

    const onDisk = statSync(outPath).size
    check(
      `300MB 条目流式解压成功（旧实现在 256MB 处返回 null）`,
      written === SIZE && onDisk === SIZE,
      `写入 ${Math.round(written / 1024 / 1024)}MB / 落盘 ${Math.round(onDisk / 1024 / 1024)}MB`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testClassifier()
  testSelection()
  await testLargeEntry()

  const target = process.argv[2]
  if (target) {
    await testRealFile(target)
  } else {
    console.log('\n（未提供 .apks 文件路径，跳过真实文件测试）')
  }

  section(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\n测试异常：', e)
  process.exit(1)
})
