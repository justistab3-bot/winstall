import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { ApkInfo, DeviceInfo, InstalledApp, AppAction } from '@shared/types'
import type { AdbManager } from './adb/manager'
import { parseApk } from './apk'

/**
 * 设备上单个已安装应用。
 * 刻意只保留「一次 shell 调用就能拿到」的字段 —— 列表要秒开、绝不卡死。
 * 应用名与图标属于昂贵信息，走 resolveDetails() 按需解析。
 */
export interface InstalledAppRaw {
  packageName: string
  apkPath: string | null
  isSystem: boolean
  isDisabled: boolean
  versionCode: number | null
  uid: number | null
}

const PKG_LINE =
  /^package:(.*)=([A-Za-z0-9_.]+?)(?:\s+versionCode:(\d+))?(?:\s+uid:(\d+))?\s*$/

export class AppManager {
  constructor(private adb: AdbManager) {}

  /**
   * 列出全部已安装应用。
   * 只发 3 条命令（都很轻），任何一条失败都会降级而不是抛错。
   */
  async list(device: DeviceInfo, signal?: AbortSignal): Promise<InstalledApp[]> {
    const [full, systemRes, disabledRes] = await Promise.all([
      this.adb.shellOn(device, 'pm list packages -f -U --show-versioncode', 30000, signal),
      this.adb.shellOn(device, 'pm list packages -s', 30000, signal),
      this.adb.shellOn(device, 'pm list packages -d', 30000, signal)
    ])

    let text = full.stdout
    // 老系统不认识 -U / --show-versioncode，降级到只带路径的版本
    if (!text.trim() || !/^package:/m.test(text)) {
      const fallback = await this.adb.shellOn(device, 'pm list packages -f', 30000, signal)
      text = fallback.stdout
    }

    const systemSet = toPackageSet(systemRes.stdout)
    const disabledSet = toPackageSet(disabledRes.stdout)
    const out: InstalledApp[] = []
    const seen = new Set<string>()

    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r+$/, '').trim()
      if (!line.startsWith('package:')) continue
      const m = PKG_LINE.exec(line)
      if (!m) continue
      const [, apkPath, packageName, versionCode, uid] = m
      if (seen.has(packageName)) continue
      seen.add(packageName)
      out.push({
        packageName,
        apkPath: apkPath || null,
        // 优先用 pm 的分类结果；拿不到时按路径兜底
        isSystem: systemSet.size > 0 ? systemSet.has(packageName) : isSystemPath(apkPath),
        isDisabled: disabledSet.has(packageName),
        versionCode: versionCode ? Number(versionCode) : null,
        uid: uid ? Number(uid) : null
      })
    }

    out.sort((a, b) => a.packageName.localeCompare(b.packageName))
    return out
  }

  /**
   * 按需解析应用名与图标：把 APK 拉到本机临时目录后用现有解析器读。
   * 只在用户主动点击某一行时调用，因此可以接受秒级耗时。
   */
  async resolveDetails(
    device: DeviceInfo,
    app: { packageName: string; apkPath: string | null },
    onProgress?: (message: string) => void
  ): Promise<ApkInfo> {
    if (!app.apkPath) throw new Error('该应用没有可访问的 APK 路径')

    const dir = path.join(tmpdir(), 'winstall-appcache')
    mkdirSync(dir, { recursive: true })
    const local = path.join(dir, `${randomUUID()}.apk`)

    try {
      onProgress?.('正在从设备读取安装包…')
      const r = await this.adb.execOn(device, ['pull', app.apkPath, local], 180000)
      if (r.code !== 0 || !existsSync(local)) {
        throw new Error(r.stderr.trim() || '读取安装包失败')
      }
      onProgress?.('正在解析应用信息…')
      return await parseApk(local)
    } finally {
      try {
        if (existsSync(local)) rmSync(local, { force: true })
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }

  /** 对设备上的应用执行一个动作 */
  async run(
    device: DeviceInfo,
    packageName: string,
    action: AppAction,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; message: string }> {
    const safe = sanitizePackage(packageName)
    if (!safe) return { ok: false, message: '包名不合法' }

    let cmd: string
    switch (action) {
      case 'launch':
        cmd = `monkey -p ${safe} -c android.intent.category.LAUNCHER 1`
        break
      case 'forceStop':
        cmd = `am force-stop ${safe}`
        break
      case 'disable':
        cmd = `pm disable-user --user 0 ${safe}`
        break
      case 'enable':
        cmd = `pm enable --user 0 ${safe}`
        break
      case 'clearData':
        cmd = `pm clear --user 0 ${safe}`
        break
      case 'uninstall':
        cmd = `pm uninstall --user 0 ${safe}`
        break
      default:
        return { ok: false, message: '不支持的操作' }
    }

    const r = await this.adb.shellOn(device, cmd, 60000, signal)
    const out = `${r.stdout}\n${r.stderr}`.trim()
    const ok = r.code === 0 && !/^Failure|Error:|Exception|not found/i.test(out)

    return { ok, message: translateAction(action, out, ok) }
  }
}

/* ------------------------------------------------------------------ */

function toPackageSet(text: string): Set<string> {
  const set = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '').trim()
    if (!line.startsWith('package:')) continue
    const name = line.slice('package:'.length).split(/\s+/)[0]
    if (name) set.add(name)
  }
  return set
}

/** 路径兜底判断：系统分区上的就是系统应用 */
function isSystemPath(p: string | null | undefined): boolean {
  if (!p) return false
  return /^\/(system|system_ext|vendor|product|apex|odm|oem)\//.test(p)
}

/** 包名只允许安全字符，避免 shell 注入 */
function sanitizePackage(pkg: string): string | null {
  const s = pkg.trim()
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(s) ? s : null
}

function translateAction(action: AppAction, out: string, ok: boolean): string {
  if (ok) {
    switch (action) {
      case 'launch':
        return '已启动'
      case 'forceStop':
        return '已强制停止'
      case 'disable':
        return '已停用'
      case 'enable':
        return '已启用'
      case 'clearData':
        return '已清除数据'
      case 'uninstall':
        return '已卸载'
    }
  }
  if (/not installed for|not found|Unknown package/i.test(out)) return '设备上找不到该应用'
  if (/DELETE_FAILED_INTERNAL_ERROR/i.test(out)) return '系统拒绝卸载（可能是系统关键应用）'
  if (/SecurityException|Permission Denial/i.test(out)) return '权限不足，系统拒绝该操作'
  if (/No activities found/i.test(out)) return '该应用没有可启动的界面'
  if (/Failure/i.test(out)) return out.split('\n').find((l) => /Failure/i.test(l))?.trim() ?? out
  return out.split('\n')[0] || '操作失败'
}
