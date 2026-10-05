import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

export class SettingsStore {
  private file: string
  private data: AppSettings

  constructor() {
    const dir = app.getPath('userData')
    this.file = path.join(dir, 'settings.json')
    this.data = this.load()
  }

  private load(): AppSettings {
    try {
      if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS }
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // 与默认值合并，保证新增字段在旧配置上也有值
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  get(): AppSettings {
    return { ...this.data }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.data = { ...this.data, ...patch }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      /* 写盘失败不影响本次会话 */
    }
    return this.get()
  }
}
