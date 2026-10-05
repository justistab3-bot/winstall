/**
 * scripts/apk-probe.ts —— APK 解析引擎验证脚本
 *
 * 用法：
 *   cd D:\worker\apk-installer && npx tsx scripts/apk-probe.ts [样本目录]
 *
 * 默认样本目录：D:\worker\_apk_samples
 * 会解析目录下所有 .apk，并逐字段打印 ApkInfo 的完整结果。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { parseApkDetailed, type ApkParseDetails } from '../src/main/apk/index'
import type { ApkInfo } from '../src/shared/types'

/* ------------------------------- 输出工具 ------------------------------- */

const W = 74

function rule(ch = '─'): string {
  return ch.repeat(W)
}

function title(text: string): string {
  const pad = Math.max(0, W - text.length - 2)
  return `\n${'═'.repeat(W)}\n ${text}${' '.repeat(pad)}\n${'═'.repeat(W)}`
}

function row(label: string, value: string): string {
  const l = label.padEnd(20, ' ')
  return `  ${l} : ${value}`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB (${n} B)`
  return `${(n / 1024 / 1024).toFixed(2)} MB (${n} B)`
}

function fmtNullable(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string' && v === '') return "'' (空字符串)"
  return String(v)
}

function describeIcon(dataUrl: string | null): string[] {
  if (!dataUrl) return ['null']
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) return [`⚠ 不是合法 data URL（长度 ${dataUrl.length}）`]
  const mime = m[1]
  const b64 = m[2]
  const approxBytes = Math.floor((b64.length * 3) / 4)
  let magic = '(未知)'
  try {
    const head = Buffer.from(b64.slice(0, 16), 'base64')
    if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) magic = 'PNG 签名 ✓'
    else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
      magic = 'JPEG 签名 ✓'
    else if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF') magic = 'WebP 签名 ✓'
    else magic = `未知头 ${head.subarray(0, 4).toString('hex')}`
  } catch {
    magic = '(解码失败)'
  }
  return [
    `${mime}  |  data URL 长度 ${dataUrl.length} 字符`,
    `base64 长度 ${b64.length}  →  约 ${fmtBytes(approxBytes)}  |  ${magic}`
  ]
}

/* ------------------------------- 单条打印 ------------------------------- */

function printInfo(fileName: string, d: ApkParseDetails, elapsedMs: number): void {
  const i: ApkInfo = d.info
  console.log(title(`📦 ${fileName}`))
  console.log(row('filePath', i.filePath))
  console.log(row('fileName', i.fileName))
  console.log(row('fileSize', fmtBytes(i.fileSize)))
  console.log(rule())
  console.log(row('packageName', fmtNullable(i.packageName)))
  console.log(row('versionName', fmtNullable(i.versionName)))
  console.log(row('versionCode', fmtNullable(i.versionCode)))
  console.log(rule())
  console.log(row('minSdk', fmtNullable(i.minSdk)))
  console.log(row('targetSdk', fmtNullable(i.targetSdk)))
  console.log(row('compileSdk', fmtNullable(i.compileSdk)))
  console.log(rule())
  console.log(row('appLabel', fmtNullable(i.appLabel)))
  const iconLines = describeIcon(i.iconDataUrl)
  console.log(row('iconDataUrl', iconLines[0]))
  for (const extra of iconLines.slice(1)) {
    console.log(`  ${' '.repeat(20)}   ${extra}`)
  }
  console.log(rule())
  console.log(row('nativeAbis', i.nativeAbis.length ? JSON.stringify(i.nativeAbis) : '[]'))
  console.log(row('hasNativeLibs', String(i.hasNativeLibs)))
  console.log(row('debuggable', String(i.debuggable)))
  console.log(row('testOnly', String(i.testOnly)))
  console.log(row('isSplit', String(i.isSplit)))
  console.log(
    row(
      'permissions',
      i.permissions.length === 0
        ? '[]'
        : `[${i.permissions.length}] ${JSON.stringify(i.permissions)}`
    )
  )
  console.log(rule())
  console.log(row('parseError', fmtNullable(i.parseError)))
  console.log(row('parsedAt', `${i.parsedAt} (${new Date(i.parsedAt).toISOString()})`))
  console.log(rule())
  console.log(row('launchableActivity', fmtNullable(d.launchableActivity)))
  console.log(row('resourcePackages', JSON.stringify(d.resourcePackages)))
  console.log(row('warnings', d.warnings.length ? JSON.stringify(d.warnings) : '[]'))
  console.log(row('解析耗时', `${elapsedMs.toFixed(1)} ms`))
}

/* --------------------------------- 主流程 -------------------------------- */

function resolveSampleDir(): string {
  const fromArg = process.argv[2]
  if (fromArg) return path.resolve(fromArg)
  return 'D:\\worker\\_apk_samples'
}

async function main(): Promise<void> {
  const dir = resolveSampleDir()
  console.log(`APK 解析探针  |  Node ${process.version}  |  样本目录: ${dir}`)

  let files: string[]
  try {
    const all = await fsp.readdir(dir)
    files = all.filter((f) => f.toLowerCase().endsWith('.apk')).sort()
  } catch (err) {
    console.error(`✗ 无法读取样本目录：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }

  if (files.length === 0) {
    console.error('✗ 样本目录下没有 .apk 文件')
    process.exitCode = 1
    return
  }

  const results: { name: string; info: ApkInfo; ok: boolean; ms: number }[] = []

  for (const f of files) {
    const full = path.join(dir, f)
    const t0 = performance.now()
    let details: ApkParseDetails
    try {
      details = await parseApkDetailed(full)
    } catch (err) {
      // parseApk 理论上永不 reject，这里只做防御
      console.error(title(`💥 ${f}`))
      console.error(`  parseApk 抛出了异常（不应发生）：${err instanceof Error ? err.stack : err}`)
      process.exitCode = 1
      continue
    }
    const ms = performance.now() - t0
    printInfo(f, details, ms)
    results.push({ name: f, info: details.info, ok: details.info.parseError === null, ms })
  }

  /* ------------------------------- 汇总表 ------------------------------- */
  console.log(title('📊 汇总'))
  const header = [
    'file'.padEnd(34),
    'pkg'.padEnd(26),
    'minSdk'.padStart(6),
    'tgt'.padStart(4),
    'verName'.padEnd(10),
    'label'.padEnd(16),
    'icon'.padStart(7),
    'abis'
  ].join(' ')
  console.log(header)
  console.log(rule())
  for (const r of results) {
    const i = r.info
    console.log(
      [
        r.name.slice(0, 34).padEnd(34),
        String(i.packageName ?? 'null').slice(0, 26).padEnd(26),
        String(i.minSdk ?? 'null').padStart(6),
        String(i.targetSdk ?? 'null').padStart(4),
        String(i.versionName ?? 'null').slice(0, 10).padEnd(10),
        String(i.appLabel ?? 'null').slice(0, 16).padEnd(16),
        String(i.iconDataUrl ? i.iconDataUrl.length : 'null').padStart(7),
        JSON.stringify(i.nativeAbis)
      ].join(' ')
    )
  }
  console.log(rule())

  const failed = results.filter((r) => !r.ok)
  console.log(
    `总计 ${results.length} 个样本：成功 ${results.length - failed.length}，` +
      `有 parseError ${failed.length}，总耗时 ${results.reduce((a, r) => a + r.ms, 0).toFixed(0)} ms`
  )
  for (const r of failed) {
    console.log(`  ⚠ ${r.name}: ${r.info.parseError}`)
  }
  if (failed.length > 0) process.exitCode = 1
}

void main()
