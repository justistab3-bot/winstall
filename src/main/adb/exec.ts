import { spawn, type ChildProcess } from 'node:child_process'

export interface RunOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  /** 实时回调 stdout 片段（用于解析 push 进度等） */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** 覆写编码，默认 utf8 */
  encoding?: BufferEncoding
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** spawn 本身失败（例如可执行文件不存在）时的错误信息 */
  spawnError: string | null
  durationMs: number
}

/**
 * 无 shell 直接拉起子进程并收集输出。
 * 永不 reject —— 所有失败都通过 RunResult 表达，调用方不必写 try/catch。
 */
export function run(exe: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const started = Date.now()

  return new Promise<RunResult>((resolve) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let child: ChildProcess

    const finish = (partial: Partial<RunResult> & { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort)
      resolve({
        timedOut,
        aborted,
        spawnError: null,
        durationMs: Date.now() - started,
        ...partial
      })
    }

    const encoding = options.encoding ?? 'utf8'
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined

    try {
      child = spawn(exe, args, {
        windowsHide: true,
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      finish({ code: null, stdout: '', stderr: '', spawnError: (err as Error).message })
      return
    }

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString(encoding)
      stdout += text
      options.onStdout?.(text)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString(encoding)
      stderr += text
      options.onStderr?.(text)
    })

    child.on('error', (err) => {
      finish({ code: null, stdout, stderr, spawnError: err.message })
    })

    child.on('close', (code) => {
      finish({ code, stdout, stderr })
    })

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, options.timeoutMs)
    }

    if (options.signal) {
      onAbort = () => {
        aborted = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 拆分命令行输出为去空行、去 \r 的行数组 */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0)
}
