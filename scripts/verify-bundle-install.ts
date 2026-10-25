/**
 * 分包安装端到端验证：走真实的 Installer（含 root 路径），装完再卸掉。
 *
 *   npx tsx scripts/verify-bundle-install.ts "<xapk/apks 路径>" [--root] [--keep]
 *
 * 默认会在安装完成后卸载测试包，不会在设备上留下东西。
 */
import { AdbManager } from '../src/main/adb/manager'
import { Installer } from '../src/main/installer'
import { parseApk } from '../src/main/apk'
import { selectionFor } from '../src/shared/compat'
import type { DeviceInfo, InstallOptions, InstallProgress } from '../src/shared/types'

const bundlePath = process.argv[2]
const useRoot = process.argv.includes('--root')
const keep = process.argv.includes('--keep')

if (!bundlePath) {
  console.error('用法: npx tsx scripts/verify-bundle-install.ts "<bundle 路径>" [--root] [--keep]')
  process.exit(1)
}

async function main(): Promise<void> {
  const adb = new AdbManager({
    resourcesPath: process.cwd(),
    appPath: process.cwd(),
    userDataPath: process.cwd(),
    home: process.env.USERPROFILE ?? ''
  })

  if (!(await adb.ensureServer())) {
    console.error('ADB 不可用')
    process.exit(1)
  }
  await adb.refreshDevices()

  const device: DeviceInfo | undefined = adb.getDevices().find((d) => d.state === 'device')
  if (!device) {
    console.error('没有可用设备')
    process.exit(1)
  }
  await adb.enrichDevice(device.id)

  console.log(`设备: ${device.model}   Android ${device.androidRelease} (API ${device.sdkInt})`)
  console.log(`位宽: ${device.bitness}   ABI: ${device.abiList.join(', ')}`)
  console.log(`密度: ${device.densityDpi}dpi   语言: ${device.locale}`)

  // root 检测
  const hasRoot = await adb.checkRoot(device)
  console.log(`Root: ${hasRoot ? '可用 ✓' : '不可用'}`)
  if (useRoot && !hasRoot) {
    console.log('⚠ 指定了 --root 但设备没有 root，将退回普通安装')
  }

  console.log('\n解析分包容器…')
  const info = await parseApk(bundlePath)
  console.log(`  包名 ${info.packageName}`)
  console.log(`  应用名 ${info.appLabel}`)
  console.log(`  容器 ${info.bundleKind} / 分包 ${info.bundle?.splits.length ?? 0} 个`)
  if (info.parseError) {
    console.error(`  解析失败: ${info.parseError}`)
    process.exit(1)
  }

  const sel = selectionFor(info, device)
  if (!sel || sel.error) {
    console.error(`\n✗ 分包与设备不匹配: ${sel?.error ?? '未知'}`)
    process.exit(1)
  }
  const picked = sel.splits.filter((s) => s.selected)
  const bytes = picked.reduce((n, s) => n + s.rawSize, 0)
  console.log(`\n选中 ${picked.length}/${sel.splits.length} 个分包，共 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  for (const s of picked) console.log(`  · ${s.entryName}  (${s.kind}${s.abi ? ` ${s.abi}` : ''})`)
  if (sel.warning) console.log(`  ⚠ ${sel.warning}`)

  const options: InstallOptions = {
    replace: true,
    grantAll: true,
    allowDowngrade: false,
    allowTest: false,
    launchAfterInstall: false,
    rootInstall: useRoot && hasRoot,
    rootForceUninstall: false
  }

  console.log(`\n开始安装（root=${options.rootInstall}）…`)
  const installer = new Installer(adb)
  let lastStage = ''
  const handle = installer.install(device, info, options, (p: InstallProgress) => {
    const line = `${p.stage} ${p.indeterminate ? '…' : `${p.percent}%`} ${p.message}`
    if (line !== lastStage) {
      lastStage = line
      console.log(`  ${line}`)
    }
  })

  const result = await handle.result
  console.log('')
  if (result.ok) {
    console.log(`✓ 安装成功，耗时 ${result.durationMs}ms`)
  } else {
    console.log(`✗ 安装失败: ${result.errorTitle}`)
    console.log(`  ${result.errorDetail}`)
    if (result.rawOutput) console.log(`  原始输出: ${result.rawOutput.split('\n').slice(-6).join('\n  ')}`)
  }

  // 验证是否真的装上了
  if (result.ok && info.packageName) {
    const check = await adb.shellOn(device, `pm path ${info.packageName}`, 15000)
    const paths = check.stdout.trim().split('\n').filter(Boolean)
    console.log(`\n设备上确认: ${paths.length} 个 APK 路径`)
    for (const p of paths) console.log(`  ${p}`)
  }

  // 清理：卸载测试包
  if (result.ok && info.packageName && !keep) {
    console.log('\n清理：卸载测试包…')
    const un = await adb.shellOn(device, `pm uninstall ${info.packageName}`, 90000)
    console.log(`  ${/\bSuccess\b/i.test(un.stdout) ? '✓ 已卸载' : `卸载输出: ${un.stdout.trim() || un.stderr.trim()}`}`)
  } else if (keep) {
    console.log('\n（--keep：保留安装结果）')
  }

  adb.dispose()
  process.exit(result.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('异常:', e)
  process.exit(1)
})
