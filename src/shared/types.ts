/**
 * 主进程 <-> 渲染进程 共享类型契约
 * 该文件是 IPC 的唯一真源，改动需同步 src/preload 与 src/renderer。
 */

/** 设备位宽：32 位 / 64 位 / 两者皆可 / 未知 */
export type ArchBitness = '32' | '64' | 'both' | 'unknown'

export type DeviceState =
  | 'device'
  | 'unauthorized'
  | 'offline'
  | 'bootloader'
  | 'recovery'
  | 'sideload'
  | 'connecting'
  | 'unknown'

export interface DeviceInfo {
  /**
   * 稳定身份，用于选中与查找。
   * 正常情况下等于序列号；**部分设备（USB 描述符未写入序列号）没有序列号**，
   * adb 会显示为 "(no serial number)"，这类设备只能用 transport_id 定位，
   * 此时 id 为 "transport-<n>"。
   */
  id: string
  /** adb 报告的序列号；无序列号时为 "(no serial number)" */
  serial: string
  /** 设备未提供序列号。为 true 时所有 adb 调用必须改用 -t <transportId> */
  serialMissing: boolean
  state: DeviceState
  model: string | null
  product: string | null
  device: string | null
  transportId: string | null

  /** 以下字段需要 shell 权限，插入瞬间可能为 null，enriched=true 后才有值 */
  enriched: boolean
  enrichError: string | null
  androidRelease: string | null // "13"
  sdkInt: number | null // 33
  abi: string | null // 主 ABI，如 arm64-v8a
  abiList: string[]
  abiList32: string[]
  abiList64: string[]
  bitness: ArchBitness
  manufacturer: string | null
  brand: string | null
  isEmulator: boolean
  /** 剩余存储（字节） */
  storageFreeBytes: number | null
  batteryLevel: number | null
}

export interface ApkInfo {
  filePath: string
  fileName: string
  fileSize: number
  packageName: string | null
  versionName: string | null
  versionCode: number | null
  minSdk: number | null
  targetSdk: number | null
  compileSdk: number | null
  /** 应用显示名（从 resources.arsc 解析，可能为 null） */
  appLabel: string | null
  /** 应用图标 data URL（image/png;base64,...），可能为 null */
  iconDataUrl: string | null
  /** APK 内 lib/ 目录包含的 ABI 列表，如 ['arm64-v8a','armeabi-v7a'] */
  nativeAbis: string[]
  hasNativeLibs: boolean
  debuggable: boolean
  testOnly: boolean
  /** 是否 split APK（缺少 base 的配置分包） */
  isSplit: boolean
  permissions: string[]
  parseError: string | null
  parsedAt: number
}

export type CompatLevel = 'ok' | 'info' | 'warning' | 'error'

export interface CompatIssue {
  level: CompatLevel
  /** 机器可读代码，便于前端定制图标 */
  code: string
  title: string
  detail: string
}

export interface CompatReport {
  /** 综合结论：能否安装 */
  installable: boolean
  level: CompatLevel
  headline: string
  issues: CompatIssue[]
  /** 将使用的 ABI（若有 native 库） */
  matchedAbi: string | null
}

/* ------------------------------- 安装流水线 ------------------------------- */

export type InstallStage =
  | 'idle'
  | 'preparing'
  | 'pushing'
  | 'installing'
  | 'cleaning'
  | 'success'
  | 'failed'

export interface InstallProgress {
  taskId: string
  stage: InstallStage
  /** 0-100；pushing 阶段为真实字节进度，installing 阶段为不确定进度 */
  percent: number
  indeterminate: boolean
  message: string
  /** 原始 adb 输出行，用于日志面板 */
  raw?: string
  bytesSent?: number
  bytesTotal?: number
}

export interface InstallResult {
  taskId: string
  ok: boolean
  stage: InstallStage
  /** 面向用户的失败原因（已翻译） */
  errorTitle?: string
  errorDetail?: string
  /** 原始 pm install 输出 */
  rawOutput?: string
  packageName?: string | null
  durationMs: number
}

export interface InstallOptions {
  /** -r 覆盖安装 */
  replace: boolean
  /** -g 安装时授予全部运行时权限 */
  grantAll: boolean
  /** -d 允许版本降级 */
  allowDowngrade: boolean
  /** -t 允许测试包 */
  allowTest: boolean
  /** 安装后自动启动主 Activity */
  launchAfterInstall: boolean
}

/* ------------------------------ 应用管理 ------------------------------ */

export type AppAction =
  | 'launch'
  | 'forceStop'
  | 'disable'
  | 'enable'
  | 'clearData'
  | 'uninstall'

/**
 * 设备上已安装的应用。
 * 只包含一次 shell 调用就能拿到的字段 —— 列表必须秒开，不能因为应用多而卡死。
 * 应用名与图标属于昂贵信息，通过 IPC.appResolve 按需解析。
 */
export interface InstalledApp {
  packageName: string
  apkPath: string | null
  isSystem: boolean
  isDisabled: boolean
  versionCode: number | null
  uid: number | null
  /** 按需解析出来的应用名（未解析时为 null） */
  label?: string | null
  /** 按需解析出来的图标 data URL */
  iconDataUrl?: string | null
}

export interface AppActionResult {
  packageName: string
  action: AppAction
  ok: boolean
  message: string
}

/* ------------------------------ 动态取色 ------------------------------ */

export interface DynamicColorState {
  /** 是否启用壁纸动态取色 */
  enabled: boolean
  /** 提取到的种子色（#RRGGBB） */
  seed: string | null
  /** 壁纸文件路径（用于展示来源） */
  wallpaperPath: string | null
  /** 未能取色时的原因 */
  error: string | null
}

/* --------------------------------- ADB --------------------------------- */

export type AdbFixLevel = 'info' | 'fixed' | 'warn'

export interface AdbLogEntry {
  id: string
  at: number
  level: AdbFixLevel
  /** 自动修复动作标题，如「清理端口 5037 上的旧 adb 服务」 */
  title: string
  detail?: string
}

export interface AdbStatus {
  /** 是否已定位到 adb 可执行文件 */
  available: boolean
  adbPath: string | null
  /** adb 来源：bundled / sdk / path / downloaded */
  source: 'bundled' | 'sdk' | 'path' | 'appdata' | 'env' | null
  clientVersion: string | null
  serverVersion: string | null
  /** 实际使用的 adb server 端口 */
  serverPort: number
  /** 端口是否被非 adb 进程占用而被迫改端口 */
  portConflict: boolean
  /** 是否发生过版本不匹配冲突 */
  versionConflict: boolean
  /** 正在运行的诊断/修复动作 */
  busy: boolean
  lastError: string | null
  logs: AdbLogEntry[]
}

/* ------------------------------- IPC 通道 ------------------------------- */

export const IPC = {
  // 设备
  deviceList: 'device:list',
  deviceChanged: 'device:changed', // main -> renderer push
  deviceRefresh: 'device:refresh',

  // APK
  apkPick: 'apk:pick',
  apkParse: 'apk:parse', // 传入路径数组（拖拽）
  apkParseProgress: 'apk:parseProgress',

  // 安装
  installStart: 'install:start',
  installProgress: 'install:progress', // main -> renderer push
  installResult: 'install:result', // main -> renderer push
  installCancel: 'install:cancel',
  /** 启动设备上已安装的应用（安装成功后按钮用） */
  appLaunch: 'app:launch',

  // 应用管理
  appsList: 'apps:list',
  appsResolve: 'apps:resolve',
  appsRun: 'apps:run',

  // ADB
  adbStatus: 'adb:status',
  adbChanged: 'adb:changed', // main -> renderer push
  adbRepair: 'adb:repair',

  // 动态取色
  colorState: 'color:state',
  colorChanged: 'color:changed', // main -> renderer push
  colorRefresh: 'color:refresh',

  // 系统
  openExternal: 'sys:openExternal',
  getSettings: 'sys:getSettings',
  setSettings: 'sys:setSettings',
  windowMinimize: 'win:minimize',
  windowMaximize: 'win:maximize',
  windowClose: 'win:close',
  revealFile: 'sys:revealFile'
} as const

export interface AppSettings extends InstallOptions {
  theme: 'system' | 'light' | 'dark'
  /** 自定义 adb 路径（空表示自动发现） */
  adbPathOverride: string
  /** 安装完成后自动清理 /data/local/tmp */
  autoCleanup: boolean
  /** 根据 Windows 壁纸自动取色（Material You） */
  dynamicColor: boolean
  /** 拖入多个安装包时，装完一个自动继续下一个 */
  batchInstall: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  adbPathOverride: '',
  replace: true,
  grantAll: true,
  allowDowngrade: false,
  allowTest: false,
  launchAfterInstall: false,
  autoCleanup: true,
  dynamicColor: true,
  batchInstall: true
}
