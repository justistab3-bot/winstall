/**
 * 端到端集成测试：不使用 Electron，直接驱动 AdbManager / Installer / 兼容性引擎。
 *
 *   npx tsx scripts/integration-test.ts            # 只读检查（不安装）
 *   npx tsx scripts/integration-test.ts --install  # 追加真实安装验证
 */
import path from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import {
  AdbManager,
  NO_SERIAL,
  deviceSelector,
  parseDevicesLine,
  parsePlainDevices,
  parseProtoTextDevices,
  rawLines
} from '../src/main/adb/manager'
import { AppManager } from '../src/main/apps'
import { Installer } from '../src/main/installer'
import { parseApk } from '../src/main/apk'
import { evaluateCompat, pickMatchedAbi } from '../src/shared/compat'
import type { ApkInfo, DeviceInfo, InstallProgress } from '../src/shared/types'

const SAMPLES = 'D:\\worker\\_apk_samples'
const DO_INSTALL = process.argv.includes('--install')

let failures = 0

function check(label: string, ok: boolean, extra = ''): void {
  const mark = ok ? '  ✓' : '  ✗'
  if (!ok) failures++
  console.log(`${mark} ${label}${extra ? `  ${extra}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`)
}

/* ------------------------------------------------------------------ */

function fakeApk(over: Partial<ApkInfo>): ApkInfo {
  return {
    filePath: 'C:\\fake\\test.apk',
    fileName: 'test.apk',
    fileSize: 5_000_000,
    packageName: 'com.example.test',
    versionName: '1.0',
    versionCode: 1,
    minSdk: 19,
    targetSdk: 30,
    compileSdk: 30,
    appLabel: 'Test',
    iconDataUrl: null,
    nativeAbis: [],
    hasNativeLibs: false,
    debuggable: false,
    testOnly: false,
    isSplit: false,
    permissions: [],
    parseError: null,
    parsedAt: Date.now(),
    ...over
  }
}

function fakeDevice(over: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 'FAKE',
    serial: 'FAKE',
    serialMissing: false,
    state: 'device',
    model: 'TestDevice',
    product: null,
    device: null,
    transportId: null,
    enriched: true,
    enrichError: null,
    androidRelease: '13',
    sdkInt: 33,
    abi: 'arm64-v8a',
    abiList: ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
    abiList32: ['armeabi-v7a', 'armeabi'],
    abiList64: ['arm64-v8a'],
    bitness: 'both',
    manufacturer: null,
    brand: null,
    isEmulator: false,
    storageFreeBytes: 8_000_000_000,
    batteryLevel: null,
    ...over
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* ------------------------- 1. ADB 环境 ------------------------- */
  section('1. ADB 自动发现与冲突自愈')

  const adb = new AdbManager({
    resourcesPath: process.cwd(),
    appPath: process.cwd(),
    userDataPath: path.join(process.cwd(), '.test-userdata'),
    home: process.env.USERPROFILE ?? ''
  })

  const located = adb.locateAdb()
  check('定位到 adb 可执行文件', !!located, located ? `→ ${located.path} (${located.source})` : '')
  if (!located) {
    console.log('\n未找到 adb，后续测试无法进行。')
    process.exit(1)
  }

  const ok = await adb.ensureServer()
  const status = adb.getStatus()
  check('ADB 服务可用', ok, `客户端 ${status.clientVersion} · 端口 ${status.serverPort}`)
  check('未发生端口冲突', !status.portConflict, status.portConflict ? `已切换到 ${status.serverPort}` : '')
  console.log(`  自动处理记录 ${status.logs.length} 条：`)
  for (const l of status.logs) console.log(`    [${l.level}] ${l.title}${l.detail ? ` — ${l.detail}` : ''}`)

  /* ------------------- 1b. 无序列号设备的解析（回归） ------------------- */
  section('1b. 无序列号设备解析（真实抓包回归）')

  // 以下三段都是真机原始输出，来自一台 USB 描述符未写入序列号的 Android 13 设备。
  // 它曾导致设备被显示为「未知状态 / 无法安装」，是必须守住的回归点。

  const protoTextNoSerial =
    'device {\r\n  state: DEVICE\r\n  product: "K99"\r\n  model: "K99"\r\n' +
    '  device: "K99"\r\n  connection_type: USB\r\n  transport_id: 2\r\n}\r\n'

  const p1 = parseProtoTextDevices(protoTextNoSerial)
  check('proto-text: 缺少 serial 字段时不应丢弃设备', p1.length === 1, `解析出 ${p1.length} 条`)
  check('proto-text: 状态应为 device 而不是 unknown', p1[0]?.state === 'device', String(p1[0]?.state))
  check('proto-text: 序列号应回退为占位串', p1[0]?.serial === NO_SERIAL, String(p1[0]?.serial))
  check('proto-text: 应标记 serialMissing', p1[0]?.serialMissing === true)
  check('proto-text: id 应为 transport-2', p1[0]?.id === 'transport-2', String(p1[0]?.id))
  check('proto-text: 型号应正确解析', p1[0]?.model === 'K99', String(p1[0]?.model))

  const p2 = parsePlainDevices('(no serial number)\tdevice\r\n')
  check('纯文本: 含空格的序列号应完整保留', p2[0]?.serial === NO_SERIAL, JSON.stringify(p2[0]?.serial))
  check('纯文本: 状态应为 device', p2[0]?.state === 'device', String(p2[0]?.state))

  const p3 = parseDevicesLine('(no serial number)     device product:K99 model:K99 device:K99 transport_id:2')
  check('devices -l: 序列号不应被切成 "(no"', p3?.serial === NO_SERIAL, JSON.stringify(p3?.serial))
  check('devices -l: 状态不应被误读为 unknown', p3?.state === 'device', String(p3?.state))
  check('devices -l: transport_id 应解析出来', p3?.transportId === '2', String(p3?.transportId))
  check('devices -l: id 应为 transport-2', p3?.id === 'transport-2', String(p3?.id))

  // 正常设备的对照，确保修复没有破坏原路径
  const normal = parseDevicesLine('BS371P800CY0151238     device product:P600PRO model:P600PRO device:P600PRO transport_id:11')
  check('正常设备: 序列号解析正确', normal?.serial === 'BS371P800CY0151238', String(normal?.serial))
  check('正常设备: 状态解析正确', normal?.state === 'device', String(normal?.state))
  check('正常设备: id 应等于序列号', normal?.id === 'BS371P800CY0151238', String(normal?.id))

  // 定位参数：无序列号必须用 -t，否则 adb 会报 device not found
  const selMissing = deviceSelector({ serial: NO_SERIAL, serialMissing: true, transportId: '2' })
  check('无序列号设备应使用 -t 定位', selMissing[0] === '-t' && selMissing[1] === '2', selMissing.join(' '))
  const selNormal = deviceSelector({ serial: 'ABC123', serialMissing: false, transportId: '7' })
  check('正常设备应使用 -s 定位', selNormal[0] === '-s' && selNormal[1] === 'ABC123', selNormal.join(' '))
  const selAuto = deviceSelector({ serial: NO_SERIAL, transportId: '3' })
  check('未显式标记时也能识别占位串', selAuto[0] === '-t', selAuto.join(' '))

  /* ------------------------- 2. 设备识别 ------------------------- */
  section('2. 设备识别（安卓版本 / 32-64 位）')

  const devices = await adb.refreshDevices()
  check('枚举到设备', devices.length > 0, `共 ${devices.length} 台`)
  if (devices.length === 0) {
    console.log('\n没有设备连接，跳过设备相关测试。')
    adb.dispose()
    process.exit(failures > 0 ? 1 : 0)
  }

  for (const d of devices) {
    await adb.enrichDevice(d.id)
  }

  const dev = adb.getDevices()[0]
  console.log(`\n  设备: ${dev.model} (${dev.serial})`)
  console.log(`  系统: Android ${dev.androidRelease} / API ${dev.sdkInt}`)
  console.log(`  位宽: ${dev.bitness}    ABI: ${dev.abiList.join(', ')}`)
  console.log(`  32位列表: [${dev.abiList32.join(', ')}]   64位列表: [${dev.abiList64.join(', ')}]`)
  console.log(`  剩余存储: ${dev.storageFreeBytes == null ? '未取到' : `${(dev.storageFreeBytes / 1024 ** 2).toFixed(0)} MB`}`)

  check('已读取系统版本号', dev.sdkInt != null && dev.sdkInt > 0, `API ${dev.sdkInt}`)
  check('已读取 ABI 列表', dev.abiList.length > 0)
  check('位宽判定非 unknown', dev.bitness !== 'unknown', dev.bitness)
  check('富化无错误', dev.enrichError == null, dev.enrichError ?? '')

  // 该设备是 Android 5.1 纯 32 位，作为已知基线断言
  if (dev.sdkInt === 22) {
    check('Android 5.1 位宽应判定为 32', dev.bitness === '32', dev.bitness)
    check('Android 5.1 abilist64 应为空', dev.abiList64.length === 0)
  }

  /* ------------------------- 3. APK 解析 ------------------------- */
  section('3. APK 解析')

  const files = [
    path.join(SAMPLES, 'com.keanbin.pinyinime.apk'),
    path.join(SAMPLES, 'com.pen.launcher.apk'),
    path.join(SAMPLES, 'com.topjohnwu.magisk.apk')
  ]

  const parsed: ApkInfo[] = []
  for (const f of files) {
    const info = await parseApk(f)
    parsed.push(info)
    console.log(
      `\n  ${info.fileName}\n` +
        `    包名 ${info.packageName} · v${info.versionName}(${info.versionCode})\n` +
        `    minSdk ${info.minSdk} / targetSdk ${info.targetSdk}\n` +
        `    应用名 ${info.appLabel ?? '(未解析)'} · 图标 ${info.iconDataUrl ? `${Math.round(info.iconDataUrl.length / 1024)}KB` : '无'}\n` +
        `    native ${info.nativeAbis.length ? info.nativeAbis.join(', ') : '(无)'}`
    )
    check(`${info.fileName} 解析无错误`, info.parseError == null, info.parseError ?? '')
    check(`${info.fileName} 取到包名`, !!info.packageName)
  }

  /* ------------------------- 4. 兼容性判定 ------------------------- */
  section('4. 兼容性判定（真实 APK × 真实设备）')

  for (const info of parsed) {
    const r = evaluateCompat(info, dev)
    console.log(`\n  ${info.fileName} → ${r.headline}  [${r.level}]  matchedAbi=${r.matchedAbi ?? '-'}`)
    for (const i of r.issues) console.log(`    · (${i.level}) ${i.title} — ${i.detail}`)
  }

  section('4b. 兼容性判定（构造边界场景）')

  // 这一段刻意全部使用**合成设备**，不依赖当前插着哪台真机，
  // 否则换个设备插上去断言就会莫名其妙地失败。
  const dev32 = fakeDevice({
    id: 'SYNTH-32',
    serial: 'SYNTH-32',
    model: 'Synthetic32',
    androidRelease: '5.1',
    sdkInt: 22,
    abi: 'armeabi-v7a',
    abiList: ['armeabi-v7a', 'armeabi'],
    abiList32: ['armeabi-v7a', 'armeabi'],
    abiList64: [],
    bitness: '32'
  })

  // 纯 64 位包 vs 32 位设备 —— 这是用户最关心的提示之一
  const arm64Only = fakeApk({ nativeAbis: ['arm64-v8a'], hasNativeLibs: true })
  const r1 = evaluateCompat(arm64Only, dev32)
  check(
    '仅含 arm64-v8a 的包在 32 位设备上应报错',
    !r1.installable && r1.issues.some((i) => i.code === 'abi-64-only'),
    r1.headline
  )

  // 同时含 32/64 位 → 应匹配到 32 位并放行
  const both = fakeApk({ nativeAbis: ['arm64-v8a', 'armeabi-v7a'], hasNativeLibs: true })
  const r2 = evaluateCompat(both, dev32)
  check(
    '同时含 32/64 位的包应可安装并匹配到 armeabi-v7a',
    r2.installable && r2.matchedAbi === 'armeabi-v7a',
    `matchedAbi=${r2.matchedAbi}`
  )

  // 纯 Java 包 → 任意架构可装
  const pureJava = fakeApk({ nativeAbis: [], hasNativeLibs: false })
  const r3 = evaluateCompat(pureJava, dev32)
  check('纯 Java 包应可安装', r3.installable, r3.headline)

  // minSdk 高于设备
  const tooNew = fakeApk({ minSdk: 30 })
  const r4 = evaluateCompat(tooNew, dev32)
  check(
    'minSdk 30 的包在 API 22 设备上应报错',
    !r4.installable && r4.issues.some((i) => i.code === 'min-sdk'),
    r4.headline
  )

  // 64 位设备 + 仅 32 位包
  const dev64Only = fakeDevice({
    id: 'SYNTH-64',
    serial: 'SYNTH-64',
    androidRelease: '14',
    sdkInt: 34,
    abiList: ['arm64-v8a'],
    abiList32: [],
    abiList64: ['arm64-v8a'],
    bitness: '64'
  })
  const arm32Only = fakeApk({ nativeAbis: ['armeabi-v7a'], hasNativeLibs: true })
  const r8 = evaluateCompat(arm32Only, dev64Only)
  check(
    '仅含 32 位库的包在纯 64 位设备上应报错',
    !r8.installable && r8.issues.some((i) => i.code === 'abi-32-only'),
    r8.headline
  )

  // Android 14 拒绝 targetSdk < 23
  const legacy = fakeApk({ minSdk: 19, targetSdk: 21 })
  const r5 = evaluateCompat(legacy, fakeDevice({ sdkInt: 34, androidRelease: '14' }))
  check(
    'Android 14 上 targetSdk 21 应被判定为不可安装',
    !r5.installable && r5.issues.some((i) => i.code === 'target-sdk-blocked'),
    r5.headline
  )

  // 未连接设备
  const r6 = evaluateCompat(fakeApk({}), null)
  check('无设备时应提示连接设备', !r6.installable && r6.issues.some((i) => i.code === 'no-device'))

  // 设备未授权
  const r7 = evaluateCompat(fakeApk({}), fakeDevice({ state: 'unauthorized' }))
  check('设备未授权时应报错', !r7.installable && r7.issues.some((i) => i.code === 'unauthorized'))

  // ABI 匹配工具函数
  check(
    'pickMatchedAbi 优先 64 位',
    pickMatchedAbi(['armeabi-v7a', 'arm64-v8a'], ['arm64-v8a', 'armeabi-v7a']) === 'arm64-v8a'
  )
  check('pickMatchedAbi 无交集返回 null', pickMatchedAbi(['x86_64'], ['armeabi-v7a']) === null)
  check(
    'armeabi 可回退到 armeabi-v7a 设备',
    pickMatchedAbi(['armeabi'], ['armeabi-v7a']) === 'armeabi'
  )

  /* ------------------------- 5. 安装参数 ------------------------- */
  section('5. 安装参数组装')

  const installer = new Installer(adb)
  const target = parsed.find((p) => p.packageName === 'com.pen.launcher') ?? parsed[0]
  const targetReport = evaluateCompat(target, dev)

  console.log(`  目标: ${target.appLabel} (${target.packageName})  ${target.fileName}`)
  console.log(`  结论: ${targetReport.headline}  可安装=${targetReport.installable}`)

  // pm install 参数组装：-g 只能在 API 23+ 出现
  const args22 = installer.buildInstallArgs(fakeDevice({ sdkInt: 22 }), {
    replace: true,
    grantAll: true,
    allowDowngrade: false,
    allowTest: false,
    launchAfterInstall: false
  }, '/data/local/tmp/x.apk')
  check('API 22 不应带 -g 参数', !args22.includes('-g'), args22.join(' '))

  const args33 = installer.buildInstallArgs(fakeDevice({ sdkInt: 33 }), {
    replace: true,
    grantAll: true,
    allowDowngrade: true,
    allowTest: true,
    launchAfterInstall: false
  }, '/data/local/tmp/x.apk')
  check('API 33 应带 -g / -d / -t 参数', ['-g', '-d', '-t'].every((f) => args33.includes(f)), args33.join(' '))

  /* ------------------ 5b. 安装链路管道（不落包） ------------------ */
  section('5b. 安装链路管道验证（推送 / 取大小 / 清理，不安装）')

  // 这一段走的是和真实安装完全相同的底层调用（execOn 推送、shellOn 取远端大小、清理），
  // 但不会执行 pm install —— 既能验证无序列号设备上的 -t 定位是否真的通，
  // 又不会往用户设备上装任何东西。
  if (dev.serialMissing) {
    const local = path.join(process.env.TEMP ?? process.env.TMP ?? '.', `winstall-probe-${Date.now()}.bin`)
    const remote = `/data/local/tmp/${path.basename(local)}`
    const payload = Buffer.alloc(256 * 1024, 0x41)
    writeFileSync(local, payload)

    const push = await adb.execOn(dev, ['push', local, remote], 60000)
    check('无序列号设备上 push 成功（-t 定位有效）', push.code === 0, push.stderr.trim() || `code=${push.code}`)

    const ls = await adb.shellOn(dev, `ls -l '${remote}'`, 10000)
    const f = rawLines(ls.stdout)[0]?.split(/\s+/).filter(Boolean) ?? []
    const size = f.length >= 5 ? Number(f[f.length - 4]) : NaN
    check('远端大小读取正确（ls -l 解析）', size === payload.length, `设备端 ${size} / 本地 ${payload.length}`)

    await adb.shellOn(dev, `rm -f '${remote}'`, 10000)
    const after = await adb.shellOn(dev, `ls '${remote}'`, 10000)
    check('清理后远端文件已删除', after.code !== 0 || /No such file/i.test(after.stderr + after.stdout))

    try {
      rmSync(local, { force: true })
    } catch {
      /* ignore */
    }
  } else {
    console.log('  当前设备有序列号，跳过（该分支专门覆盖 -t 定位路径）')
  }

  /* ------------------------- 5c. 应用管理 ------------------------- */
  section('5c. 应用管理列表')

  const appManager = new AppManager(adb)
  const started = Date.now()
  const installed = await appManager.list(dev)
  const elapsed = Date.now() - started

  const userCount = installed.filter((a) => !a.isSystem).length
  const sysCount = installed.filter((a) => a.isSystem).length
  console.log(`  共 ${installed.length} 个应用（用户 ${userCount} / 系统 ${sysCount}），耗时 ${elapsed}ms`)
  console.log(`  前 5 个：`)
  for (const a of installed.slice(0, 5)) {
    console.log(`    ${a.isSystem ? '[系统]' : '[用户]'} ${a.packageName}  v${a.versionCode ?? '?'}`)
  }

  check('应用列表非空', installed.length > 0, `${installed.length} 个`)
  check('应用列表耗时可接受（< 8s）', elapsed < 8000, `${elapsed}ms`)
  check('包名解析正确（无残留 versionCode 前缀）', installed.every((a) => !a.packageName.includes(' ')))
  check('能区分系统与用户应用', sysCount > 0 && userCount > 0, `系统 ${sysCount} / 用户 ${userCount}`)
  check(
    'APK 路径解析正确',
    installed.some((a) => !!a.apkPath && a.apkPath.endsWith('.apk')),
    installed.find((a) => a.apkPath)?.apkPath ?? ''
  )

  /* ------------------------- 5d. 真实安装 ------------------------- */
  section('5d. 真实安装验证')

  if (!DO_INSTALL) {
    console.log('  （未传入 --install，跳过。加该参数可执行完整安装验证。）')
  } else if (!targetReport.installable) {    console.log('\n  目标包判定为不可安装，跳过。')
  } else {
    console.log('\n  开始安装…')
    const seen: string[] = []
    const handle = installer.install(
      dev,
      target,
      {
        replace: true,
        grantAll: true,
        allowDowngrade: false,
        allowTest: false,
        launchAfterInstall: false
      },
      (p: InstallProgress) => {
        const line = `${p.stage} ${p.indeterminate ? '…' : `${p.percent}%`} ${p.message}`
        if (seen[seen.length - 1] !== line) {
          seen.push(line)
          console.log(`    ${line}`)
        }
      }
    )

    const result = await handle.result
    check('安装成功', result.ok, result.ok ? `耗时 ${result.durationMs}ms` : `${result.errorTitle}: ${result.errorDetail}`)
    if (!result.ok && result.rawOutput) console.log(`    原始输出: ${result.rawOutput}`)
    if (result.ok) {
      console.log(`    进度事件 ${seen.length} 次，最终阶段 ${result.stage}`)
      check('推送阶段产生了真实百分比进度', seen.some((s) => /pushing \d+%/.test(s)))
    }
  }

  adb.dispose()

  section(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\n集成测试异常：', err)
  process.exit(1)
})
