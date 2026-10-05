import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app, nativeImage, systemPreferences } from 'electron'
import { pickSeedFromBitmap } from '@shared/md3'
import type { DynamicColorState } from '@shared/types'

/**
 * Windows 壁纸取色（Material You 动态取色的种子来源）。
 *
 * 取色来源按可靠性排序：
 *  1. TranscodedWallpaper —— Windows 实际渲染壁纸时转码出的图片。
 *     用户用幻灯片、聚焦、纯色时，注册表里的 WallPaper 值往往是过期的，
 *     而这个文件始终是「此刻屏幕上真实显示的那张图」。
 *  2. 注册表 HKCU\Control Panel\Desktop\WallPaper
 *  3. Windows 强调色（系统自己的「从壁纸自动取色」结果）
 *  4. 都没有 → 返回 null，由调用方回退到默认主题色
 */

function regQueryWallpaper(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        // 形如:  WallPaper    REG_SZ    C:\Users\x\pic.jpg
        const m = /WallPaper\s+REG_SZ\s+(.+?)\s*$/m.exec(stdout)
        const p = m?.[1]?.trim()
        resolve(p && existsSync(p) ? p : null)
      }
    )
  })
}

function transcodedWallpaper(): string | null {
  try {
    const p = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** 从一个图片文件里提取种子色 */
function seedFromImageFile(file: string): string | null {
  try {
    const buf = readFileSync(file)
    if (buf.length === 0 || buf.length > 40 * 1024 * 1024) return null
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null

    // 缩到 64×64 再取色：足够代表整图配色，且耗时可以忽略
    const small = img.resize({ width: 64, height: 64, quality: 'good' })
    const size = small.getSize()
    if (size.width === 0 || size.height === 0) return null
    return pickSeedFromBitmap(small.toBitmap(), size.width, size.height)
  } catch {
    return null
  }
}

/** Windows 强调色（8 位 hex，形如 "RRGGBBAA"） */
function accentSeed(): string | null {
  try {
    const accent = systemPreferences.getAccentColor()
    if (accent && accent.length >= 6) return `#${accent.slice(0, 6).toUpperCase()}`
  } catch {
    /* 非 Windows 平台或不可用 */
  }
  return null
}

export async function computeDynamicColor(enabled: boolean): Promise<DynamicColorState> {
  if (!enabled) {
    return { enabled: false, seed: null, wallpaperPath: null, error: null }
  }

  const transcoded = transcodedWallpaper()
  const registry = await regQueryWallpaper()

  for (const candidate of [transcoded, registry]) {
    if (!candidate) continue
    const seed = seedFromImageFile(candidate)
    if (seed) {
      return { enabled: true, seed, wallpaperPath: candidate, error: null }
    }
  }

  const accent = accentSeed()
  if (accent) {
    return {
      enabled: true,
      seed: accent,
      wallpaperPath: null,
      error: transcoded || registry ? '壁纸图片未能提取到鲜艳颜色，已改用系统强调色' : '未找到壁纸文件，已改用系统强调色'
    }
  }

  return {
    enabled: true,
    seed: null,
    wallpaperPath: transcoded ?? registry,
    error: '未能从壁纸提取到可用颜色，已使用默认主题色'
  }
}
