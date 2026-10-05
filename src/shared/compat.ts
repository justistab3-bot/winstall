import type { ApkInfo, CompatIssue, CompatReport, DeviceInfo } from '@shared/types'

/** API Level → 版本号 / 代号 */
const ANDROID_VERSIONS: Record<number, { v: string; name: string }> = {
  1: { v: '1.0', name: 'Android 1.0' },
  2: { v: '1.1', name: 'Android 1.1' },
  3: { v: '1.5', name: 'Cupcake' },
  4: { v: '1.6', name: 'Donut' },
  5: { v: '2.0', name: 'Eclair' },
  7: { v: '2.1', name: 'Eclair' },
  8: { v: '2.2', name: 'Froyo' },
  9: { v: '2.3', name: 'Gingerbread' },
  10: { v: '2.3.3', name: 'Gingerbread' },
  11: { v: '3.0', name: 'Honeycomb' },
  13: { v: '3.2', name: 'Honeycomb' },
  14: { v: '4.0', name: 'Ice Cream Sandwich' },
  15: { v: '4.0.3', name: 'Ice Cream Sandwich' },
  16: { v: '4.1', name: 'Jelly Bean' },
  17: { v: '4.2', name: 'Jelly Bean' },
  18: { v: '4.3', name: 'Jelly Bean' },
  19: { v: '4.4', name: 'KitKat' },
  20: { v: '4.4W', name: 'KitKat Wear' },
  21: { v: '5.0', name: 'Lollipop' },
  22: { v: '5.1', name: 'Lollipop' },
  23: { v: '6.0', name: 'Marshmallow' },
  24: { v: '7.0', name: 'Nougat' },
  25: { v: '7.1', name: 'Nougat' },
  26: { v: '8.0', name: 'Oreo' },
  27: { v: '8.1', name: 'Oreo' },
  28: { v: '9', name: 'Pie' },
  29: { v: '10', name: 'Android 10' },
  30: { v: '11', name: 'Android 11' },
  31: { v: '12', name: 'Android 12' },
  32: { v: '12L', name: 'Android 12L' },
  33: { v: '13', name: 'Android 13' },
  34: { v: '14', name: 'Android 14' },
  35: { v: '15', name: 'Android 15' },
  36: { v: '16', name: 'Android 16' }
}

/** 给 API 级别一个人类可读的名字，例如 "Android 5.1 (API 22)" */
export function describeSdk(sdk: number | null | undefined, release?: string | null): string {
  if (sdk == null) return release ? `Android ${release}` : '未知系统'
  const info = ANDROID_VERSIONS[sdk]
  const v = release && release.trim() ? release.trim() : info?.v
  return v ? `Android ${v} (API ${sdk})` : `API ${sdk}`
}

const ABI_LABEL: Record<string, string> = {
  'arm64-v8a': 'ARM 64 位',
  'armeabi-v7a': 'ARM 32 位',
  armeabi: 'ARM 32 位 (旧)',
  x86_64: 'x86 64 位',
  x86: 'x86 32 位',
  mips64: 'MIPS 64 位',
  mips: 'MIPS 32 位',
  riscv64: 'RISC-V 64 位'
}

export function abiLabel(abi: string): string {
  return ABI_LABEL[abi] ?? abi
}

/** 判定某个 ABI 是否为 64 位 */
export function is64BitAbi(abi: string): boolean {
  return /arm64|x86_64|mips64|riscv64|(^|[_-])64($|[_-])/i.test(abi) || abi.endsWith('64')
}

/**
 * 后备兼容表：APK 里只含 key 这种库时，设备若支持 value 中任一 ABI 也能跑。
 * 主要用于 armeabi（可被 armeabi-v7a 设备执行）等历史情况。
 */
const ABI_FALLBACK: Record<string, string[]> = {
  armeabi: ['armeabi-v7a', 'arm64-v8a'],
  x86: ['x86_64'],
  mips: ['mips64']
}

/** 64 位优先、版本高的优先 */
const ABI_RANK = [
  'arm64-v8a',
  'armeabi-v7a',
  'armeabi',
  'x86_64',
  'x86',
  'mips64',
  'mips',
  'riscv64'
]

/** 在设备支持的 ABI 中，为 APK 挑一个可用的 */
export function pickMatchedAbi(apkAbis: string[], deviceAbis: string[]): string | null {
  if (apkAbis.length === 0) return null
  const dev = new Set(deviceAbis)

  const direct = apkAbis.filter((a) => dev.has(a))
  if (direct.length > 0) {
    return direct.sort((a, b) => rank(a) - rank(b))[0]
  }
  for (const abi of apkAbis) {
    const fb = ABI_FALLBACK[abi]
    if (fb?.some((x) => dev.has(x))) return abi
  }
  return null
}

function rank(abi: string): number {
  const i = ABI_RANK.indexOf(abi)
  return i < 0 ? 99 : i
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const LEVEL_WEIGHT = { ok: 0, info: 1, warning: 2, error: 3 } as const

/**
 * 综合判定 APK 能否装到设备上。
 * 纯函数，便于渲染进程复用同一套结论。
 */
export function evaluateCompat(apk: ApkInfo | null, device: DeviceInfo | null): CompatReport {
  const issues: CompatIssue[] = []

  if (!apk) {
    return {
      installable: false,
      level: 'info',
      headline: '请选择或拖入 APK 安装包',
      issues: [],
      matchedAbi: null
    }
  }

  if (apk.parseError && !apk.packageName) {
    issues.push({
      level: 'error',
      code: 'parse-failed',
      title: '安装包无法解析',
      detail: apk.parseError
    })
  }

  if (!device) {
    issues.push({
      level: 'info',
      code: 'no-device',
      title: '未检测到设备',
      detail: '请用 USB 连接 Android 设备，并确认已开启「USB 调试」。'
    })
    // 没有设备时绝不能报告「可安装」—— finish() 只把 error 视为阻断，
    // 而这条是 info，所以这里必须显式兜底。
    return { ...finish(issues, null), installable: false }
  }

  if (device.state === 'unauthorized') {
    issues.push({
      level: 'error',
      code: 'unauthorized',
      title: '设备未授权',
      detail: '请在设备屏幕上点击「允许 USB 调试」，勾选「一律允许」后重试。'
    })
  } else if (device.state === 'offline') {
    issues.push({
      level: 'error',
      code: 'offline',
      title: '设备离线',
      detail: '设备连接状态异常，可点击「修复连接」重新握手，或重新插拔 USB。'
    })
  } else if (device.state === 'connecting') {
    issues.push({
      level: 'warning',
      code: 'connecting',
      title: '正在与设备握手',
      detail: '请稍候，正在读取设备信息…'
    })
  } else if (device.state !== 'device') {
    issues.push({
      level: 'error',
      code: 'not-ready',
      title: '设备当前不可安装',
      detail: `设备状态为 ${device.state}，请切换到正常系统后重试。`
    })
  }

  if (!device.enriched && device.state === 'device') {
    issues.push({
      level: 'info',
      code: 'enriching',
      title: '正在读取设备信息',
      detail: '正在获取系统版本与 CPU 架构…'
    })
  }

  /* ------------------------- 系统版本 ------------------------- */
  if (device.sdkInt != null && apk.minSdk != null) {
    if (apk.minSdk > device.sdkInt) {
      issues.push({
        level: 'error',
        code: 'min-sdk',
        title: '系统版本过低，无法安装',
        detail:
          `该安装包要求 ${describeSdk(apk.minSdk)}（minSdk ${apk.minSdk}），` +
          `当前设备为 ${describeSdk(device.sdkInt, device.androidRelease)}。` +
          `至少需要升级到 ${describeSdk(apk.minSdk)} 才能安装。`
      })
    } else {
      issues.push({
        level: 'ok',
        code: 'min-sdk-ok',
        title: '系统版本满足要求',
        detail: `要求 ${describeSdk(apk.minSdk)} 及以上，当前 ${describeSdk(device.sdkInt, device.androidRelease)}。`
      })
    }
  }

  /* ------------------------- targetSdk 风险 ------------------------- */
  if (apk.targetSdk != null && device.sdkInt != null) {
    if (device.sdkInt >= 34 && apk.targetSdk < 23) {
      issues.push({
        level: 'error',
        code: 'target-sdk-blocked',
        title: '系统禁止安装该应用',
        detail:
          `Android 14 及以上已禁止安装 targetSdk 低于 23 的应用，` +
          `该包 targetSdk 为 ${apk.targetSdk}。请改用适配过的版本。`
      })
    } else if (device.sdkInt >= 26 && apk.targetSdk < 26) {
      issues.push({
        level: 'warning',
        code: 'target-sdk-low',
        title: 'targetSdk 偏低，可能无法正常运行',
        detail:
          `该包 targetSdk 为 ${apk.targetSdk}，在 ${describeSdk(device.sdkInt, device.androidRelease)} 上` +
          `可能因后台限制、权限模型变化而异常。`
      })
    } else if (device.sdkInt >= 33 && apk.targetSdk < 31) {
      issues.push({
        level: 'info',
        code: 'target-sdk-info',
        title: '未适配新版通知权限',
        detail: `targetSdk ${apk.targetSdk} 低于 31，在 Android 13+ 上通知可能不会主动弹出授权。`
      })
    }
  }

  /* ------------------------- CPU 架构 ------------------------- */
  let matchedAbi: string | null = null
  if (apk.hasNativeLibs && apk.nativeAbis.length > 0) {
    matchedAbi = pickMatchedAbi(apk.nativeAbis, device.abiList)
    const apkIs64Only = apk.nativeAbis.every(is64BitAbi)
    const apkIs32Only = apk.nativeAbis.every((a) => !is64BitAbi(a))

    if (matchedAbi) {
      const bits = is64BitAbi(matchedAbi) ? '64 位' : '32 位'
      issues.push({
        level: 'ok',
        code: 'abi-ok',
        title: `CPU 架构兼容（${bits}）`,
        detail:
          `安装包包含 ${apk.nativeAbis.join('、')}，将使用 ${matchedAbi}（${abiLabel(matchedAbi)}）运行。`
      })
    } else if (device.bitness === '32' && apkIs64Only) {
      issues.push({
        level: 'error',
        code: 'abi-64-only',
        title: '该安装包仅支持 64 位，当前设备为 32 位',
        detail:
          `安装包只包含 64 位库（${apk.nativeAbis.join('、')}），` +
          `而设备 ${device.model ?? device.serial} 是纯 32 位（${device.abiList.join('、') || '未知'}），无法运行。` +
          `请下载 32 位版本（通常是 armeabi-v7a）。`
      })
    } else if (device.bitness === '64' && apkIs32Only) {
      issues.push({
        level: 'error',
        code: 'abi-32-only',
        title: '该安装包仅支持 32 位，当前设备为纯 64 位',
        detail:
          `安装包只包含 32 位库（${apk.nativeAbis.join('、')}），` +
          `设备仅支持 ${device.abiList.join('、')}，无法运行。请下载 64 位版本。`
      })
    } else {
      issues.push({
        level: 'error',
        code: 'abi-mismatch',
        title: 'CPU 架构不匹配',
        detail:
          `安装包包含 ${apk.nativeAbis.join('、')}，` +
          `设备支持 ${device.abiList.join('、') || '未知'}，两者没有交集。`
      })
    }
  } else if (!apk.hasNativeLibs && apk.packageName) {
    issues.push({
      level: 'ok',
      code: 'no-native',
      title: '纯 Java / Kotlin 应用',
      detail: '不含 native 库，32 位与 64 位设备均可安装运行。'
    })
  }

  /* ------------------------- 存储空间 ------------------------- */
  if (device.storageFreeBytes != null && apk.fileSize > 0) {
    // 安装后大致占用：APK + 解压后的 dex/so，保守按 3 倍估算
    const need = apk.fileSize * 3
    if (device.storageFreeBytes < need) {
      issues.push({
        level: 'warning',
        code: 'storage',
        title: '存储空间可能不足',
        detail:
          `设备剩余 ${fmtSize(device.storageFreeBytes)}，` +
          `安装包 ${fmtSize(apk.fileSize)}，安装过程预计需要约 ${fmtSize(need)}。`
      })
    }
  }

  /* ------------------------- 其他 ------------------------- */
  if (apk.isSplit) {
    issues.push({
      level: 'warning',
      code: 'split-apk',
      title: '这可能是分包（Split APK）',
      detail: '该包缺少 base 或标记了 isSplitRequired，单独安装可能失败，需要一并提供其他分包。'
    })
  }
  if (apk.testOnly) {
    issues.push({
      level: 'info',
      code: 'test-only',
      title: '测试版安装包',
      detail: '该包标记为 testOnly，安装时需勾选「允许测试包」，否则会被系统拒绝。'
    })
  }

  return finish(issues, matchedAbi)
}

function finish(issues: CompatIssue[], matchedAbi: string | null): CompatReport {
  const level = issues.reduce<CompatIssue['level']>(
    (acc, i) => (LEVEL_WEIGHT[i.level] > LEVEL_WEIGHT[acc] ? i.level : acc),
    'ok'
  )
  const installable = !issues.some((i) => i.level === 'error')

  let headline: string
  if (!installable) {
    // 不要拿第一条错误的标题当结论 —— 它紧接着会在下方问题列表里再出现一次，读起来像重复
    const errorCount = issues.filter((i) => i.level === 'error').length
    headline = errorCount > 1 ? `存在 ${errorCount} 项问题，无法安装` : '无法安装'
  } else if (level === 'warning') {
    headline = '可以安装，但需注意'
  } else {
    headline = '兼容性检查通过'
  }

  const order = { error: 0, warning: 1, ok: 2, info: 3 } as const
  issues.sort((a, b) => order[a.level] - order[b.level])

  return { installable, level, headline, issues, matchedAbi }
}
