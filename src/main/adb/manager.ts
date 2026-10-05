import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { AdbLogEntry, AdbStatus, DeviceInfo, DeviceState } from '@shared/types'
import { lines, run } from './exec'

export type AdbSource = NonNullable<AdbStatus['source']>

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'

/**
 * 宿主路径。由 Electron 主进程注入，而不是直接依赖 electron 模块 ——
 * 这样 AdbManager 可以在纯 Node 环境下被集成测试直接驱动。
 */
export interface HostPaths {
  /** 打包后 resources 目录（含随包分发的 platform-tools） */
  resourcesPath?: string
  /** 开发态应用根目录 */
  appPath?: string
  /** 用户数据目录 */
  userDataPath?: string
  /** 用户主目录 */
  home?: string
}

export const EMPTY_HOST_PATHS: HostPaths = {}

/**
 * 设备未提供序列号时 adb 的占位串。
 * 注意它**含有空格和括号**，按空白切分会把 serial 切碎 —— 解析时必须先定位状态词。
 */
export const NO_SERIAL = '(no serial number)'

/** adb devices 里可能出现的状态词，用于把「含空格的序列号」和状态区分开 */
const STATE_TOKENS = new Set([
  'device',
  'offline',
  'unauthorized',
  'authorizing',
  'connecting',
  'recovery',
  'rescue',
  'sideload',
  'bootloader',
  'fastboot',
  'host'
])

function isStateToken(t: string): boolean {
  return STATE_TOKENS.has(t.toLowerCase()) || /^no\s*permissions?$/i.test(t)
}

/**
 * 构造 adb 的设备定位参数。
 * 没有序列号的设备用 `-s "(no serial number)"` 会直接报 device not found，
 * 必须改用 `-t <transport_id>`。
 */
export function deviceSelector(d: {
  serial?: string | null
  serialMissing?: boolean
  transportId?: string | null
}): string[] {
  const serial = (d.serial ?? '').trim()
  const missing = d.serialMissing ?? (!serial || serial === NO_SERIAL)
  if (!missing && serial) return ['-s', serial]
  if (d.transportId) return ['-t', String(d.transportId)]
  return ['-s', serial]
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 拆分 adb shell 输出。
 * 注意：Android 5.x 的 PTY 会把 \n 变成 \r\n，于是实际是 \r\r\n；
 * 且 getprop 取不到属性时会输出**空行**，所以这里必须保留空行，
 * 否则按行号取值会整体错位。
 */
export function rawLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((l) => l.replace(/\r+$/, '').trim())
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    const done = (v: boolean) => {
      try {
        srv.close()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    srv.once('error', () => resolve(false))
    srv.once('listening', () => done(true))
    srv.listen(port, '127.0.0.1')
  })
}

/** 查端口占用者（Windows 用 netstat + tasklist） */
async function findPortOwner(port: number): Promise<{ pid: number; name: string } | null> {
  if (process.platform !== 'win32') return null
  const r = await run('netstat', ['-ano', '-p', 'TCP'], { timeoutMs: 8000 })
  for (const row of lines(r.stdout)) {
    const f = row.split(/\s+/).filter(Boolean)
    if (f.length < 5) continue
    if (f[3]?.toUpperCase() !== 'LISTENING') continue
    if (!f[1]?.endsWith(`:${port}`)) continue
    const pid = Number(f[4])
    if (!Number.isFinite(pid) || pid <= 0) continue
    return { pid, name: await processName(pid) }
  }
  return null
}

async function processName(pid: number): Promise<string> {
  const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 })
  const first = lines(r.stdout)[0]
  if (!first) return `PID ${pid}`
  const m = /^"([^"]+)"/.exec(first)
  return m ? m[1] : `PID ${pid}`
}

async function killProcess(pid: number): Promise<boolean> {
  const r = await run('taskkill', ['/F', '/PID', String(pid)], { timeoutMs: 8000 })
  return r.code === 0
}

function mapState(raw: string): DeviceState {
  switch (raw.trim().toLowerCase()) {
    case 'device':
      return 'device'
    case 'offline':
      return 'offline'
    case 'unauthorized':
      return 'unauthorized'
    case 'authorizing':
    case 'connecting':
      return 'connecting'
    case 'recovery':
      return 'recovery'
    case 'sideload':
      return 'sideload'
    case 'bootloader':
    case 'fastboot':
      return 'bootloader'
    default:
      return 'unknown'
  }
}

/** 从 `adb version` 输出解析客户端版本号 */
function parseClientVersion(out: string): string | null {
  const m = /^Version\s+(\S+)/m.exec(out)
  if (m) return m[1]
  const m2 = /Android Debug Bridge version\s+(\S+)/.exec(out)
  return m2 ? m2[1] : null
}

/** 解析 `adb track-devices --proto-text` 的 protobuf-text 负载（导出以便回归测试） */
export function parseProtoTextDevices(payload: string): Array<Partial<DeviceInfo> & { id: string }> {
  const out: Array<Partial<DeviceInfo> & { id: string }> = []
  let cur: Record<string, string> | null = null
  for (const raw of payload.split('\n')) {
    const line = raw.replace(/\r+$/, '').trim()
    if (!line) continue
    if (/^device\s*\{$/.test(line)) {
      cur = {}
      continue
    }
    if (line === '}') {
      if (cur) {
        const transportId = (cur.transport_id ?? '').trim() || null
        const rawSerial = (cur.serial ?? '').trim()
        // 无序列号的设备在 proto-text 里**完全没有 serial 字段**，
        // 早期实现要求 serial 存在，导致这类设备被整条丢弃
        const serialMissing = rawSerial.length === 0
        const serial = serialMissing ? NO_SERIAL : rawSerial
        const id = serialMissing && transportId ? `transport-${transportId}` : serial
        out.push({
          id,
          serial,
          serialMissing,
          state: mapState(cur.state ?? 'unknown'),
          model: cur.model || null,
          product: cur.product || null,
          device: cur.device || null,
          transportId
        })
      }
      cur = null
      continue
    }
    if (!cur) continue
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line)
    if (m) cur[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

/** 解析 `adb track-devices`（无 --proto-text）的纯文本负载（导出以便回归测试） */
export function parsePlainDevices(payload: string): Array<Partial<DeviceInfo> & { id: string }> {
  const out: Array<Partial<DeviceInfo> & { id: string }> = []
  for (const raw of payload.split('\n')) {
    const line = raw.replace(/\r+$/, '').trim()
    if (!line || line.startsWith('*')) continue
    const tokens = line.split(/\s+/).filter(Boolean)
    // 序列号可能含空格（如 "(no serial number)"），所以先找到状态词再回推序列号
    let stateIdx = -1
    for (let i = 1; i < tokens.length; i++) {
      if (isStateToken(tokens[i])) {
        stateIdx = i
        break
      }
    }
    if (stateIdx < 1) continue
    const serial = tokens.slice(0, stateIdx).join(' ')
    const serialMissing = serial === NO_SERIAL
    out.push({
      id: serial,
      serial,
      serialMissing,
      state: mapState(tokens[stateIdx])
    })
  }
  return out
}

/** 解析 `df /data` 的剩余空间，兼容 toybox(5.x 人类可读) 与 1K-blocks 两种格式 */
export function parseDfFreeBytes(text: string): number | null {
  const rows = rawLines(text)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
  if (rows.length === 0) return null

  let header: string[] | null = null
  let headerIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].split(/\s+/).filter(Boolean)
    if (f.some((x) => /^(Filesystem|文件系统)$/i.test(x))) {
      header = f
      headerIdx = i
      break
    }
  }
  if (!header || headerIdx < 0) return null

  let colIdx = header.findIndex((h) => /^(Free|Available|可用)$/i.test(h))
  if (colIdx < 0) colIdx = header.findIndex((h) => /^(Free|Available)/i.test(h))
  if (colIdx < 0) return null

  let unit = 1024
  if (header.some((h) => /1K-blocks|1k-blocks|1024-blocks/i.test(h))) unit = 1024
  else if (header.some((h) => /512-blocks/i.test(h))) unit = 512
  else if (header.some((h) => /^Bytes$/i.test(h))) unit = 1
  else unit = 1 // 人类可读格式（Size/Used/Free/Blksize），数值自带单位后缀

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const f = rows[i].split(/\s+/).filter(Boolean)
    // 两种布局：`/data 1.1G 161.1M 917.0M 4096`（首列即挂载点）
    //           `/dev/block/dm-5 11534336 123 10300000 11% /data`（末列才是挂载点）
    const isData = f[0] === '/data' || f[f.length - 1] === '/data'
    if (!isData) continue
    const cell = f[colIdx]
    if (!cell) continue
    const m = /^([\d.]+)\s*([KMGTkmgt])?[iI]?[bB]?$/.exec(cell.trim())
    if (!m) continue
    const num = Number(m[1])
    if (!Number.isFinite(num)) continue
    const suffix = m[2]?.toUpperCase()
    const mult = suffix
      ? { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[suffix] ?? 1
      : unit
    return Math.round(num * mult)
  }
  return null
}

/** 解析 `adb devices -l` 的单个数据行（导出以便回归测试） */
export function parseDevicesLine(row: string): (Partial<DeviceInfo> & { id: string }) | null {
  if (/^List of devices/.test(row) || row.startsWith('*')) return null
  const tokens = row.split(/\s+/).filter(Boolean)
  // 序列号可能含空格（"(no serial number)"），先定位状态词再回推
  let stateIdx = -1
  for (let i = 1; i < tokens.length; i++) {
    if (isStateToken(tokens[i])) {
      stateIdx = i
      break
    }
  }
  if (stateIdx < 1) return null

  const serial = tokens.slice(0, stateIdx).join(' ')
  const serialMissing = serial === NO_SERIAL
  const kv: Record<string, string> = {}
  for (const token of tokens.slice(stateIdx + 1)) {
    const i = token.indexOf(':')
    if (i > 0) kv[token.slice(0, i)] = token.slice(i + 1)
  }
  const transportId = kv.transport_id ?? null
  return {
    id: serialMissing && transportId ? `transport-${transportId}` : serial,
    serial,
    serialMissing,
    state: mapState(tokens[stateIdx]),
    model: kv.model ?? null,
    product: kv.product ?? null,
    device: kv.device ?? null,
    transportId
  }
}

/* ------------------------------------------------------------------ */
/* AdbManager                                                          */
/* ------------------------------------------------------------------ */

export interface AdbManagerEvents {
  devices: (devices: DeviceInfo[]) => void
  status: (status: AdbStatus) => void
}

export class AdbManager extends EventEmitter {
  constructor(private hostPaths: HostPaths = EMPTY_HOST_PATHS) {
    super()
  }

  private adbPath: string | null = null
  private source: AdbSource | null = null
  private port = 5037
  private clientVersion: string | null = null
  private serverVersion: string | null = null
  private portConflict = false
  private versionConflict = false
  private busy = false
  private lastError: string | null = null
  private logs: AdbLogEntry[] = []

  private devices = new Map<string, DeviceInfo>()
  private tracker: ChildProcess | null = null
  private trackerBuffer = Buffer.alloc(0)
  private trackerProtoText = true
  private trackerRetry = 0
  private pollTimer: NodeJS.Timeout | null = null
  /** 每台设备在途的富化任务，用于合并并发调用 */
  private enrichPromises = new Map<string, Promise<void>>()
  private stopped = true
  private logSeq = 0

  /** 用户设置的 adb 路径覆盖 */
  adbPathOverride = ''

  /* ---------------------------- 状态 ---------------------------- */

  getStatus(): AdbStatus {
    return {
      available: !!this.adbPath && !this.lastError,
      adbPath: this.adbPath,
      source: this.source,
      clientVersion: this.clientVersion,
      serverVersion: this.serverVersion,
      serverPort: this.port,
      portConflict: this.portConflict,
      versionConflict: this.versionConflict,
      busy: this.busy,
      lastError: this.lastError,
      logs: this.logs.slice(-120)
    }
  }

  getDevices(): DeviceInfo[] {
    return [...this.devices.values()]
  }

  private log(level: AdbLogEntry['level'], title: string, detail?: string): void {
    this.logs.push({ id: `adb-${++this.logSeq}`, at: Date.now(), level, title, detail })
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200)
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  private emitDevices(): void {
    this.emit('devices', this.getDevices())
  }

  /* ---------------------------- 定位 adb ---------------------------- */

  private candidates(): Array<{ p: string; source: AdbSource }> {
    const out: Array<{ p: string; source: AdbSource }> = []
    const push = (p: string | undefined | null, source: AdbSource) => {
      if (p && p.trim()) out.push({ p: path.resolve(p.trim()), source })
    }
    const host = this.hostPaths

    push(this.adbPathOverride, 'env')
    push(process.env.APK_INSTALLER_ADB, 'env')

    // 随应用分发的 platform-tools
    push(host.resourcesPath && path.join(host.resourcesPath, 'platform-tools', EXE), 'bundled')
    push(host.appPath && path.join(host.appPath, 'resources', 'platform-tools', EXE), 'bundled')
    push(host.userDataPath && path.join(host.userDataPath, 'platform-tools', EXE), 'appdata')

    for (const envName of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
      const root = process.env[envName]
      if (root) push(path.join(root, 'platform-tools', EXE), 'sdk')
    }

    const localAppData = process.env.LOCALAPPDATA
    const home = host.home
    const pf = process.env.ProgramFiles
    const pf86 = process.env['ProgramFiles(x86)']
    const sdkRoots = [
      localAppData && path.join(localAppData, 'Android', 'Sdk'),
      home && path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
      home && path.join(home, 'Android', 'Sdk'),
      'C:\\Android\\Sdk',
      'C:\\Android',
      pf && path.join(pf, 'Android', 'Sdk'),
      pf86 && path.join(pf86, 'Android', 'Sdk'),
      home && path.join(home, 'scoop', 'apps', 'adb', 'current')
    ].filter(Boolean) as string[]
    for (const root of sdkRoots) push(path.join(root, 'platform-tools', EXE), 'sdk')

    // PATH 扫描
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir.trim()) push(path.join(dir.trim(), EXE), 'path')
    }
    return out
  }

  locateAdb(): { path: string; source: AdbSource } | null {
    for (const c of this.candidates()) {
      if (isFile(c.p)) return { path: c.p, source: c.source }
    }
    return null
  }

  /* ---------------------------- 执行封装 ---------------------------- */

  /** 所有 adb 调用都带上 -P，避免与系统默认端口的服务串味 */
  private adbArgs(args: string[]): string[] {
    return ['-P', String(this.port), ...args]
  }

  async exec(args: string[], timeoutMs = 20000, signal?: AbortSignal) {
    if (!this.adbPath) {
      return {
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: 'adb 不可用',
        durationMs: 0
      }
    }
    return run(this.adbPath, this.adbArgs(args), { timeoutMs, signal })
  }

  /** 在指定设备上执行 adb 子命令（自动选用 -s 或 -t 定位） */
  async execOn(
    device: { serial: string; serialMissing?: boolean; transportId?: string | null },
    args: string[],
    timeoutMs = 20000,
    signal?: AbortSignal
  ) {
    return this.exec([...deviceSelector(device), ...args], timeoutMs, signal)
  }

  /** 在指定设备上执行 shell 命令 */
  async shellOn(
    device: { serial: string; serialMissing?: boolean; transportId?: string | null },
    cmd: string,
    timeoutMs = 20000,
    signal?: AbortSignal
  ) {
    return this.execOn(device, ['shell', cmd], timeoutMs, signal)
  }

  /* ---------------------------- 冲突自愈 ---------------------------- */

  private async pickFreePort(): Promise<number | null> {
    for (let p = 5038; p <= 5057; p++) {
      if (await isPortFree(p)) return p
    }
    return null
  }

  private async resolveConflict(): Promise<boolean> {
    const owner = await findPortOwner(this.port)

    if (!owner) {
      // 端口空闲却启动失败 → 多半是残留的 daemon 状态，强制重置
      await this.exec(['kill-server'], 10000)
      this.log('fixed', 'ADB 服务状态异常，已强制重置', `端口 ${this.port} 未被占用但服务启动失败`)
      return true
    }

    if (/^adb(\.exe)?$/i.test(owner.name)) {
      const ok = await killProcess(owner.pid)
      this.log(
        ok ? 'fixed' : 'warn',
        ok ? `已结束占用 ${this.port} 端口的旧 ADB 服务` : `无法结束旧 ADB 服务（PID ${owner.pid}）`,
        `${owner.name} · PID ${owner.pid}`
      )
      return ok
    }

    const alt = await this.pickFreePort()
    if (alt == null) {
      this.lastError = `端口 ${this.port} 被 ${owner.name} 占用，且未找到可用替代端口`
      this.log('warn', 'ADB 端口冲突无法自动解决', this.lastError)
      return false
    }
    this.log(
      'warn',
      `端口 ${this.port} 被「${owner.name}」占用，已自动切换到 ${alt}`,
      `占用进程 PID ${owner.pid}。切换到独立端口后不受该程序影响。`
    )
    this.port = alt
    this.portConflict = true
    return true
  }

  /** 确保 adb 可用且服务健康；返回是否可用 */
  async ensureServer(): Promise<boolean> {
    this.busy = true
    this.emitStatus()
    try {
      this.lastError = null

      const found = this.locateAdb()
      if (!found) {
        this.adbPath = null
        this.source = null
        this.lastError = '未找到 adb。请安装 Android SDK platform-tools，或在设置中手动指定 adb 路径。'
        this.log('warn', '未找到 adb 可执行文件')
        return false
      }
      if (found.path !== this.adbPath) {
        this.log('info', `已定位 adb：${found.path}`, `来源：${sourceLabel(found.source)}`)
      }
      this.adbPath = found.path
      this.source = found.source

      // 1) 客户端版本
      const v = await this.exec(['version'], 8000)
      if (v.spawnError) {
        this.lastError = `无法执行 adb：${v.spawnError}`
        this.log('warn', '无法执行 adb', this.lastError)
        return false
      }
      this.clientVersion = parseClientVersion(v.stdout)

      // 2) 启动服务
      let start = await this.exec(['start-server'], 25000)
      let combined = `${start.stdout}\n${start.stderr}`

      if (/doesn'?t match this client|does not match this client/i.test(combined)) {
        this.versionConflict = true
        this.log(
          'fixed',
          '检测到版本不一致的旧 ADB 服务，已自动重启',
          `当前 adb ${this.clientVersion ?? '未知'}`
        )
      }

      const failed =
        start.code !== 0 ||
        /cannot bind|could not read ok from ADB server|failed to start daemon|Address already in use|以一种访问权限不允许的方式/i.test(
          combined
        )

      if (failed) {
        const fixed = await this.resolveConflict()
        if (fixed) {
          start = await this.exec(['start-server'], 25000)
          combined = `${start.stdout}\n${start.stderr}`
          if (/doesn'?t match this client/i.test(combined)) this.versionConflict = true
        }
      }

      // 3) 校验服务真的能用
      const probe = await this.exec(['devices'], 12000)
      const probeOut = `${probe.stdout}\n${probe.stderr}`
      if (probe.spawnError || (probe.code !== 0 && !/List of devices attached/.test(probeOut))) {
        this.lastError =
          lines(probeOut)[0] ?? probe.spawnError ?? 'ADB 服务无法响应，请检查是否有其他手机助手类软件占用端口。'
        this.log('warn', 'ADB 服务校验失败', this.lastError)
        return false
      }

      this.serverVersion = this.clientVersion
      return true
    } finally {
      this.busy = false
      this.emitStatus()
    }
  }

  /** 用户手动点击「修复连接」 */
  async repair(): Promise<boolean> {
    this.log('info', '开始手动修复 ADB 连接…')
    this.busy = true
    this.emitStatus()
    try {
      await this.exec(['kill-server'], 10000)
      this.port = 5037
      this.portConflict = false
      this.versionConflict = false
      const ok = await this.ensureServer()
      if (ok) {
        await this.exec(['reconnect', 'offline'], 10000)
        this.log('fixed', 'ADB 连接已重置')
        await this.refreshDevices()
      }
      return ok
    } finally {
      this.busy = false
      this.emitStatus()
    }
  }

  /* ---------------------------- 设备枚举 ---------------------------- */

  async listDevices(): Promise<Array<Partial<DeviceInfo> & { id: string }>> {
    const r = await this.exec(['devices', '-l'], 12000)
    const out: Array<Partial<DeviceInfo> & { id: string }> = []
    for (const row of lines(r.stdout)) {
      const parsed = parseDevicesLine(row)
      if (parsed) out.push(parsed)
    }
    return out
  }

  private blankDevice(partial: Partial<DeviceInfo> & { id: string }): DeviceInfo {
    return {
      id: partial.id,
      serial: partial.serial ?? partial.id,
      serialMissing: partial.serialMissing ?? false,
      state: partial.state ?? 'unknown',
      model: partial.model ?? null,
      product: partial.product ?? null,
      device: partial.device ?? null,
      transportId: partial.transportId ?? null,
      enriched: false,
      enrichError: null,
      androidRelease: null,
      sdkInt: null,
      abi: null,
      abiList: [],
      abiList32: [],
      abiList64: [],
      bitness: 'unknown',
      manufacturer: null,
      brand: null,
      isEmulator: false,
      storageFreeBytes: null,
      batteryLevel: null
    }
  }

  /** 合并一次设备列表快照，触发增量事件 */
  private applySnapshot(list: Array<Partial<DeviceInfo> & { id: string }>): void {
    const seen = new Set<string>()
    let changed = false

    for (const item of list) {
      seen.add(item.id)
      const existing = this.devices.get(item.id)
      if (!existing) {
        const dev = this.blankDevice(item)
        this.devices.set(item.id, dev)
        changed = true
        void this.enrichDevice(item.id)
      } else {
        // 状态变化时更新并重新富化
        if (
          existing.state !== (item.state ?? 'unknown') ||
          (item.model && existing.model !== item.model) ||
          (item.transportId && existing.transportId !== item.transportId)
        ) {
          existing.state = item.state ?? 'unknown'
          existing.model = item.model ?? existing.model
          existing.product = item.product ?? existing.product
          existing.device = item.device ?? existing.device
          existing.transportId = item.transportId ?? existing.transportId
          changed = true
          if (existing.state === 'device' && !existing.enriched) void this.enrichDevice(item.id)
        }
      }
    }

    for (const id of [...this.devices.keys()]) {
      if (!seen.has(id)) {
        this.devices.delete(id)
        changed = true
      }
    }

    if (changed) this.emitDevices()
  }

  async refreshDevices(): Promise<DeviceInfo[]> {
    const list = await this.listDevices()
    this.applySnapshot(list)
    return this.getDevices()
  }

  /* ---------------------------- 设备富化 ---------------------------- */

  private static readonly PROBE = [
    'getprop ro.build.version.release',
    'getprop ro.build.version.sdk',
    'getprop ro.product.cpu.abilist',
    'getprop ro.product.cpu.abilist32',
    'getprop ro.product.cpu.abilist64',
    'getprop ro.product.cpu.abi',
    'getprop ro.product.model',
    'getprop ro.product.manufacturer',
    'getprop ro.product.brand',
    'getprop ro.build.characteristics',
    'getprop ro.hardware',
    'df /data'
  ].join('; ')

  /**
   * 富化设备信息（系统版本 / ABI / 存储）。
   *
   * 同一设备并发调用时返回**同一个在途 Promise**，而不是直接 return。
   * 早期实现在重入时立刻返回，导致 await 的调用方在数据还没取到时就被唤醒。
   */
  async enrichDevice(id: string): Promise<void> {
    const inflight = this.enrichPromises.get(id)
    if (inflight) return inflight

    const dev = this.devices.get(id)
    if (!dev || dev.state !== 'device') return

    const task = this.doEnrich(dev).finally(() => {
      this.enrichPromises.delete(id)
    })
    this.enrichPromises.set(id, task)
    return task
  }

  private async doEnrich(dev: DeviceInfo): Promise<void> {
    try {
      const r = await this.shellOn(dev, AdbManager.PROBE, 20000)
      if (r.spawnError || (r.code !== 0 && !r.stdout.trim())) {
        dev.enrichError = r.spawnError ?? lines(r.stderr)[0] ?? '读取设备信息失败'
        dev.enriched = true
        this.emitDevices()
        return
      }

      const rows = rawLines(r.stdout)
      let release = rows[0] ?? ''
      let sdkRaw = rows[1] ?? ''

      // 极端情况下（个别 ROM 有多余输出）行号会错位，退化为逐个 getprop
      if (!/^\d+$/.test(sdkRaw.trim())) {
        const slow = await this.shellOn(
          dev,
          'getprop ro.build.version.release; getprop ro.build.version.sdk',
          15000
        )
        const srows = rawLines(slow.stdout)
        if (/^\d+$/.test((srows[1] ?? '').trim())) {
          release = srows[0] ?? ''
          sdkRaw = srows[1] ?? ''
        }
      }

      const abiList = splitAbi(rows[2] ?? '')
      const abiList32 = splitAbi(rows[3] ?? '')
      const abiList64 = splitAbi(rows[4] ?? '')
      const primaryAbi = (rows[5] ?? '').trim() || abiList[0] || null

      dev.androidRelease = release.trim() || null
      const sdk = Number(sdkRaw.trim())
      dev.sdkInt = Number.isFinite(sdk) && sdk > 0 ? sdk : null
      dev.abi = primaryAbi
      dev.abiList = abiList
      dev.abiList32 = abiList32
      dev.abiList64 = abiList64
      dev.bitness = computeBitness(abiList, abiList32, abiList64, primaryAbi)
      dev.model = (rows[6] ?? '').trim() || dev.model
      dev.manufacturer = (rows[7] ?? '').trim() || null
      dev.brand = (rows[8] ?? '').trim() || null

      const chars = (rows[9] ?? '').toLowerCase()
      const hardware = (rows[10] ?? '').toLowerCase()
      dev.isEmulator =
        chars.includes('emulator') ||
        /goldfish|ranchu|generic_x86|vbox|qemu/.test(hardware) ||
        /sdk_gphone|emulator/.test((dev.model ?? '').toLowerCase())

      dev.storageFreeBytes = parseDfFreeBytes(rows.slice(11).join('\n'))
      dev.enriched = true
      dev.enrichError = null
      this.emitDevices()
    } catch (err) {
      dev.enrichError = err instanceof Error ? err.message : String(err)
      dev.enriched = true
      this.emitDevices()
    }
  }

  /* ---------------------------- 实时跟踪 ---------------------------- */

  private handleTrackerPayload(payload: string): void {
    const list = this.trackerProtoText ? parseProtoTextDevices(payload) : parsePlainDevices(payload)
    if (list.length === 0 && payload.trim().length === 0) {
      this.applySnapshot([])
      return
    }
    this.applySnapshot(list)
  }

  private onTrackerData(chunk: Buffer): void {
    this.trackerBuffer = Buffer.concat([this.trackerBuffer, chunk])
    for (;;) {
      if (this.trackerBuffer.length < 4) return
      const lenHex = this.trackerBuffer.subarray(0, 4).toString('ascii')
      if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
        // 不是长度前缀 → 该 adb 版本按纯文本输出，切换解析模式
        this.trackerProtoText = false
        const text = this.trackerBuffer.toString('utf8')
        this.trackerBuffer = Buffer.alloc(0)
        this.handleTrackerPayload(text)
        return
      }
      const len = parseInt(lenHex, 16)
      if (this.trackerBuffer.length < 4 + len) return
      const payload = this.trackerBuffer.subarray(4, 4 + len).toString('utf8')
      this.trackerBuffer = this.trackerBuffer.subarray(4 + len)
      this.handleTrackerPayload(payload)
    }
  }

  private spawnTracker(withProtoText: boolean): void {
    if (!this.adbPath || this.stopped) return
    this.trackerBuffer = Buffer.alloc(0)
    const args = this.adbArgs(['track-devices', ...(withProtoText ? ['--proto-text'] : [])])
    let child: ChildProcess
    try {
      child = spawn(this.adbPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return
    }
    this.tracker = child
    this.trackerProtoText = withProtoText

    const startedAt = Date.now()
    let stderr = ''

    child.stdout?.on('data', (b: Buffer) => this.onTrackerData(b))
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })

    child.on('error', () => {
      this.tracker = null
    })

    child.on('close', () => {
      this.tracker = null
      if (this.stopped) return

      // --proto-text 不被支持时立刻退出 → 回退到纯文本模式
      if (withProtoText && Date.now() - startedAt < 1500 && /unknown|unrecognized|usage/i.test(stderr)) {
        this.log('info', '当前 adb 不支持 --proto-text，已回退兼容模式')
        this.spawnTracker(false)
        return
      }
      // 异常退出 → 退避重连
      if (this.trackerRetry < 5) {
        this.trackerRetry++
        setTimeout(() => this.spawnTracker(this.trackerProtoText), 1000 * this.trackerRetry)
      }
    })
  }

  startTracking(): void {
    this.stopped = false
    this.trackerRetry = 0
    this.spawnTracker(true)

    if (this.pollTimer) clearInterval(this.pollTimer)
    // 兜底轮询：track-devices 万一失效也能保证状态正确
    this.pollTimer = setInterval(() => {
      void this.refreshDevices()
    }, 5000)
  }

  stopTracking(): void {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.tracker) {
      try {
        this.tracker.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.tracker = null
    }
  }

  /** 应用退出时收拾干净（不杀服务，避免影响用户其他工具） */
  dispose(): void {
    this.stopTracking()
  }
}

/* ------------------------------------------------------------------ */

function splitAbi(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function computeBitness(
  abiList: string[],
  abiList32: string[],
  abiList64: string[],
  primaryAbi: string | null
): DeviceInfo['bitness'] {
  const has32 = abiList32.length > 0
  const has64 = abiList64.length > 0
  if (has32 && has64) return 'both'
  if (has64) return '64'
  if (has32) return '32'

  // 老设备没有 abilist32/64，按 ABI 名字推断
  const all = abiList.length ? abiList : primaryAbi ? [primaryAbi] : []
  if (all.length === 0) return 'unknown'
  const is64 = (a: string) => /(^|_)(64|arm64|arm64-v8a|x86_64|mips64)/i.test(a) || a.endsWith('64')
  const only32 = all.every((a) => !is64(a))
  const only64 = all.every((a) => is64(a))
  if (only32) return '32'
  if (only64) return '64'
  return 'both'
}

function sourceLabel(s: AdbSource): string {
  switch (s) {
    case 'bundled':
      return '应用内置'
    case 'sdk':
      return 'Android SDK'
    case 'path':
      return '系统 PATH'
    case 'appdata':
      return '应用数据目录'
    case 'env':
      return '自定义路径'
    default:
      return String(s)
  }
}
