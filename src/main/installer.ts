import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  ApkInfo,
  DeviceInfo,
  InstallOptions,
  InstallProgress,
  InstallResult
} from '@shared/types'
import { rawLines, type AdbManager } from './adb/manager'

/* ------------------------------------------------------------------ */
/* 失败原因翻译                                                        */
/* ------------------------------------------------------------------ */

interface Friendly {
  title: string
  detail: string
}

const INSTALL_ERRORS: Record<string, Friendly> = {
  INSTALL_FAILED_ALREADY_EXISTS: {
    title: '应用已存在',
    detail: '设备上已经安装了该应用。请勾选「覆盖安装」后重试。'
  },
  INSTALL_FAILED_VERSION_DOWNGRADE: {
    title: '版本降级被拒绝',
    detail: '设备上已安装的版本号更高。如需强制安装旧版本，请在设置中开启「允许版本降级」。'
  },
  INSTALL_FAILED_OLDER_SDK: {
    title: '系统版本过低',
    detail: '该应用要求更高的 Android 版本，当前设备系统过旧。'
  },
  INSTALL_FAILED_NEWER_SDK: {
    title: '系统版本过高',
    detail: '该应用声明不支持当前设备的 Android 版本。'
  },
  INSTALL_FAILED_CPU_ABI_INCOMPATIBLE: {
    title: 'CPU 架构不兼容',
    detail: '安装包内的 native 库与设备 CPU 架构不匹配。'
  },
  INSTALL_FAILED_NO_MATCHING_ABIS: {
    title: '缺少匹配的 CPU 架构',
    detail: '安装包没有提供当前设备 CPU 架构所需的 native 库。'
  },
  INSTALL_FAILED_INSUFFICIENT_STORAGE: {
    title: '存储空间不足',
    detail: '设备剩余空间不足，请清理后重试。'
  },
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: {
    title: '签名不一致',
    detail: '设备上已安装的应用与本安装包签名不同，无法覆盖。请先卸载旧版本再安装。'
  },
  INSTALL_FAILED_DEXOPT: {
    title: '应用优化失败',
    detail: '系统在 dexopt 阶段失败，通常与安装包损坏或空间不足有关。'
  },
  INSTALL_FAILED_INVALID_APK: {
    title: '安装包无效',
    detail: 'APK 文件损坏或结构不完整，请重新下载。'
  },
  INSTALL_FAILED_INVALID_URI: {
    title: '路径无效',
    detail: '安装文件路径无法访问，请重试。'
  },
  INSTALL_FAILED_USER_RESTRICTED: {
    title: '系统限制了安装',
    detail:
      '设备系统禁止了本次安装。请到「开发者选项」中开启「通过 USB 安装应用」（小米/华为/OPPO 等机型通常需要）。'
  },
  INSTALL_FAILED_VERIFICATION_FAILURE: {
    title: '被安装校验拦截',
    detail: '系统的应用校验未通过，可尝试关闭「通过 USB 验证应用」后重试。'
  },
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: {
    title: '安装包未签名',
    detail: '该 APK 没有签名，Android 拒绝安装。'
  },
  INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: {
    title: '签名冲突',
    detail: '安装包内不同文件的签名不一致，文件可能已被修改。'
  },
  INSTALL_FAILED_TEST_ONLY: {
    title: '这是测试版安装包',
    detail: '该包标记为 testOnly，请在设置中开启「允许测试包」后重试。'
  },
  INSTALL_FAILED_CONTAINER_ERROR: {
    title: '存储卡不可用',
    detail: '无法写入安装位置，可能是 SD 卡或存储加密问题。'
  },
  INSTALL_FAILED_MEDIA_UNAVAILABLE: {
    title: '存储不可用',
    detail: '设备存储当前不可访问。'
  },
  INSTALL_FAILED_ABORTED: {
    title: '安装被中断',
    detail: '安装过程被系统或其他应用中断。'
  },
  INSTALL_FAILED_SESSION_INVALID: {
    title: '安装会话失效',
    detail: '安装会话已失效，请重试。'
  },
  INSTALL_FAILED_INTERNAL_ERROR: {
    title: '系统内部错误',
    detail: '系统安装服务返回内部错误，建议重启设备后重试。'
  },
  INSTALL_FAILED_MISSING_SHARED_LIBRARY: {
    title: '缺少共享库',
    detail: '该应用依赖设备上不存在的共享库（常见于厂商定制应用）。'
  },
  INSTALL_FAILED_DUPLICATE_PERMISSION: {
    title: '权限重复定义',
    detail: '该应用定义的权限与设备上已有应用冲突，需先卸载冲突的应用。'
  },
  INSTALL_FAILED_CONFLICTING_PROVIDER: {
    title: 'ContentProvider 冲突',
    detail: '该应用提供的 Provider 与已安装应用冲突，需先卸载冲突应用。'
  },
  INSTALL_FAILED_SHARED_USER_INCOMPATIBLE: {
    title: '共享 UID 不兼容',
    detail: '该应用声明的共享用户 ID 与设备上已有应用不匹配。'
  },
  INSTALL_FAILED_REPLACE_COULDNT_DELETE: {
    title: '无法替换旧版本',
    detail: '系统无法删除旧版本应用，请手动卸载后重试。'
  },
  INSTALL_FAILED_UID_CHANGED: {
    title: '应用 UID 已变更',
    detail: '新旧版本 UID 不一致，请先完全卸载旧版本。'
  },
  INSTALL_PARSE_FAILED_MANIFEST_MALFORMED: {
    title: '清单文件格式错误',
    detail: 'AndroidManifest.xml 解析失败，安装包可能已损坏。'
  },
  INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION: {
    title: '解析安装包出错',
    detail: '系统在解析安装包时发生异常。'
  }
}

/** 从 pm install 的原始输出中提炼友好原因 */
export function translateInstallError(raw: string): Friendly {
  const text = raw.trim()
  if (!text) {
    return { title: '安装失败', detail: '系统未返回具体原因，请重试。' }
  }

  const m = /INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z_]+/.exec(text)
  if (m) {
    const known = INSTALL_ERRORS[m[0]]
    if (known) return known
    return {
      title: '安装被系统拒绝',
      detail: `系统返回：${m[0]}${extractAfterCode(text, m[0])}`
    }
  }

  if (/no space left|not enough space/i.test(text)) {
    return { title: '存储空间不足', detail: '设备剩余空间不足，请清理后重试。' }
  }
  if (/device offline/i.test(text)) {
    return { title: '设备已离线', detail: '设备连接中断，请重新插拔 USB 后重试。' }
  }
  if (/device unauthorized/i.test(text)) {
    return { title: '设备未授权', detail: '请在设备上允许 USB 调试。' }
  }
  if (/closed|broken pipe|EOF/i.test(text)) {
    return { title: '连接中断', detail: '与设备的连接在安装过程中断开。' }
  }
  if (/Permission denied/i.test(text)) {
    return { title: '权限不足', detail: '系统拒绝写入安装文件，请重试或重启设备。' }
  }

  const firstLine = rawLines(text)[0] ?? text
  return { title: '安装失败', detail: firstLine }
}

function extractAfterCode(text: string, code: string): string {
  const i = text.indexOf(code)
  if (i < 0) return ''
  const rest = text.slice(i + code.length).trim()
  return rest ? `（${rest.replace(/^[:\s]+/, '')}）` : ''
}

/* ------------------------------------------------------------------ */
/* 安装器                                                              */
/* ------------------------------------------------------------------ */

export interface InstallHandle {
  taskId: string
  result: Promise<InstallResult>
  cancel: () => void
}

export type ProgressSink = (p: InstallProgress) => void

/** 远端临时文件名只允许安全字符，避免 shell 引号问题 */
function safeRemoteName(localPath: string): string {
  const base = path.basename(localPath, path.extname(localPath))
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'package'
  return `.apki_${Date.now().toString(36)}_${safe}.apk`
}

export class Installer {
  constructor(private adb: AdbManager) {}

  /** 读取远端文件大小。用 `ls -l` 而非 stat/wc —— 老设备上后者往往不存在。 */
  private async remoteSize(device: DeviceInfo, remote: string, signal?: AbortSignal): Promise<number | null> {
    const r = await this.adb.shellOn(device, `ls -l '${remote}'`, 8000, signal)
    if (r.code !== 0) return null
    for (const line of rawLines(r.stdout)) {
      const f = line.split(/\s+/).filter(Boolean)
      // 两种布局：5.x 无链接数 `perms owner group SIZE date time name`
      //           新版有链接数 `perms links owner group SIZE date time name`
      // 共同点是「文件名往前数第 4 个字段」就是大小
      if (f.length < 5) continue
      const cell = f[f.length - 4]
      if (/^\d+$/.test(cell)) return Number(cell)
    }
    return null
  }

  /**
   * 组装 pm install 参数。
   * 关键：-g（安装时授予全部权限）是 API 23 才有的参数，
   * 在 Android 5.x 上传递会导致 pm 报错，必须按设备版本裁剪。
   */
  buildInstallArgs(device: DeviceInfo, options: InstallOptions, remote: string): string[] {
    const flags: string[] = []
    if (options.replace) flags.push('-r')
    if (options.allowDowngrade) flags.push('-d')
    if (options.allowTest) flags.push('-t')
    if (options.grantAll && device.sdkInt != null && device.sdkInt >= 23) flags.push('-g')
    return ['pm', 'install', ...flags, remote]
  }

  install(
    device: DeviceInfo,
    apk: ApkInfo,
    options: InstallOptions,
    onProgress: ProgressSink
  ): InstallHandle {
    const taskId = randomUUID()
    const controller = new AbortController()
    const signal = controller.signal
    const startedAt = Date.now()
    const remote = `/data/local/tmp/${safeRemoteName(apk.filePath)}`

    const emit = (p: Omit<InstallProgress, 'taskId'>) => onProgress({ taskId, ...p })

    const result = (async (): Promise<InstallResult> => {
      const fail = (title: string, detail: string, rawOutput?: string): InstallResult => {
        emit({ stage: 'failed', percent: 100, indeterminate: false, message: title })
        return {
          taskId,
          ok: false,
          stage: 'failed',
          errorTitle: title,
          errorDetail: detail,
          rawOutput,
          packageName: apk.packageName,
          durationMs: Date.now() - startedAt
        }
      }

      /* ------------------------ 1. 准备 ------------------------ */
      emit({ stage: 'preparing', percent: 0, indeterminate: true, message: '正在准备安装环境…' })

      const check = await this.adb.shellOn(device, 'echo ready', 10000, signal)
      if (check.code !== 0 || !check.stdout.includes('ready')) {
        return fail(
          '设备无响应',
          check.stderr.trim() || '无法与设备建立 shell 连接，请重新插拔 USB 或点击「修复连接」。'
        )
      }

      /* ------------------------ 2. 推送 ------------------------ */
      const total = apk.fileSize
      emit({
        stage: 'pushing',
        percent: 0,
        indeterminate: total <= 0,
        message: '正在推送安装包到设备…',
        bytesSent: 0,
        bytesTotal: total
      })

      let lastPercent = 0
      let polling = true
      const poll = async () => {
        while (polling && !signal.aborted) {
          await sleep(280)
          if (!polling || signal.aborted) break
          const size = await this.remoteSize(device, remote, signal)
          if (size == null || total <= 0) continue
          // 留 1% 给「写入完成」，避免进度条提前到 100 后卡住
          const pct = Math.min(99, Math.floor((size / total) * 100))
          if (pct > lastPercent) {
            lastPercent = pct
            emit({
              stage: 'pushing',
              percent: pct,
              indeterminate: false,
              message: '正在推送安装包到设备…',
              bytesSent: size,
              bytesTotal: total
            })
          }
        }
      }
      const pollTask = poll()

      const push = await this.adb.execOn(
        device,
        ['push', apk.filePath, remote],
        Math.max(120000, Math.ceil((total / (512 * 1024)) * 1000)),
        signal
      )
      polling = false
      await pollTask.catch(() => undefined)

      if (signal.aborted) {
        await this.cleanup(device, remote)
        return fail('已取消', '安装已被用户取消。')
      }
      if (push.spawnError || push.code !== 0) {
        return fail(
          '推送安装包失败',
          push.stderr.trim() || push.stdout.trim() || push.spawnError || '未知错误'
        )
      }

      // 完整性校验：远端大小必须与本地一致，否则装上去的是残缺包
      const remoteFinal = await this.remoteSize(device, remote, signal)
      if (total > 0 && remoteFinal != null && remoteFinal !== total) {
        await this.cleanup(device, remote)
        return fail(
          '推送数据不完整',
          `本地 ${total} 字节，设备端 ${remoteFinal} 字节。可能是数据线接触不良或存储空间不足，请重试。`
        )
      }

      emit({
        stage: 'pushing',
        percent: 100,
        indeterminate: false,
        message: '安装包已就绪',
        bytesSent: total,
        bytesTotal: total
      })

      /* ------------------------ 3. 安装 ------------------------ */
      const args = this.buildInstallArgs(device, options, remote)
      emit({
        stage: 'installing',
        percent: 100,
        indeterminate: true,
        message: '正在安装，请稍候…',
        raw: `$ ${args.join(' ')}`
      })

      const install = await this.adb.shellOn(device, args.join(' '), 300000, signal)
      const out = `${install.stdout}\n${install.stderr}`.trim()

      if (signal.aborted) {
        await this.cleanup(device, remote)
        return fail('已取消', '安装已被用户取消。', out)
      }

      const succeeded = /\bSuccess\b/i.test(install.stdout)

      if (!succeeded) {
        // 失败时也要清掉远端残留，避免 /data/local/tmp 堆积垃圾
        await this.cleanup(device, remote)
        const friendly = translateInstallError(out)
        return fail(friendly.title, friendly.detail, out)
      }

      /* ------------------------ 4. 清理 ------------------------ */
      emit({ stage: 'cleaning', percent: 100, indeterminate: true, message: '正在清理临时文件…' })
      await this.cleanup(device, remote)

      /* ------------------------ 5. 可选启动 ------------------------ */
      if (options.launchAfterInstall && apk.packageName) {
        await this.adb.shellOn(
          device,
          `monkey -p ${apk.packageName} -c android.intent.category.LAUNCHER 1`,
          15000
        )
      }

      emit({ stage: 'success', percent: 100, indeterminate: false, message: '安装成功' })
      return {
        taskId,
        ok: true,
        stage: 'success',
        rawOutput: out,
        packageName: apk.packageName,
        durationMs: Date.now() - startedAt
      }
    })().catch((err: unknown): InstallResult => {
      const msg = err instanceof Error ? err.message : String(err)
      emit({ stage: 'failed', percent: 100, indeterminate: false, message: '安装失败' })
      return {
        taskId,
        ok: false,
        stage: 'failed',
        errorTitle: '安装过程出错',
        errorDetail: msg,
        packageName: apk.packageName,
        durationMs: Date.now() - startedAt
      }
    })

    return {
      taskId,
      result,
      cancel: () => controller.abort()
    }
  }

  private async cleanup(device: DeviceInfo, remote: string): Promise<void> {
    await this.adb.shellOn(device, `rm -f '${remote}'`, 10000)
  }

  /** 启动已安装应用的主界面 */
  async launch(device: DeviceInfo, packageName: string): Promise<boolean> {
    const r = await this.adb.shellOn(
      device,
      `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      15000
    )
    return r.code === 0 && !/No activities found|aborted/i.test(r.stdout + r.stderr)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
