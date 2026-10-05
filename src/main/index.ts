import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import {
  IPC,
  type ApkInfo,
  type AppAction,
  type AppSettings,
  type DeviceInfo,
  type DynamicColorState,
  type InstallOptions,
  type InstallProgress,
  type InstallResult
} from '@shared/types'
import { AdbManager } from './adb/manager'
import { AppManager } from './apps'
import { evaluateCompat } from '@shared/compat'
import { Installer } from './installer'
import { parseApk } from './apk'
import { SettingsStore } from './settings'
import { computeDynamicColor } from './wallpaper'

/* ------------------------------------------------------------------ */
/* 单例状态                                                            */
/* ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null
let adb: AdbManager
let installer: Installer
let appManager: AppManager
let settings: SettingsStore
let colorState: DynamicColorState = { enabled: false, seed: null, wallpaperPath: null, error: null }

/** 已解析 APK 缓存：路径 -> 信息（含 mtime 校验，避免读到旧结果） */
const apkCache = new Map<string, { info: ApkInfo; mtimeMs: number }>()
/** 正在进行的安装任务 */
const runningTasks = new Map<string, { cancel: () => void }>()

const THEME_OVERLAY = {
  dark: { color: '#141218', symbolColor: '#e6e1e5' },
  light: { color: '#fef7ff', symbolColor: '#1d1b20' }
} as const

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function overlayColors(): { color: string; symbolColor: string } {
  const dark = nativeTheme.shouldUseDarkColors
  return dark ? THEME_OVERLAY.dark : THEME_OVERLAY.light
}

function createWindow(): void {
  const colors = overlayColors()

  mainWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: colors.color,
    title: 'Winstall',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: 48
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('maximize', () => send('win:state', true))
  mainWindow.on('unmaximize', () => send('win:state', false))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function applyTheme(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme
  const colors = overlayColors()
  try {
    mainWindow?.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: 48
    })
  } catch {
    /* 某些平台不支持，忽略 */
  }
  send('theme:changed', {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    source: nativeTheme.themeSource
  })
}

/* ------------------------------------------------------------------ */
/* APK 解析                                                            */
/* ------------------------------------------------------------------ */

async function parseApkCached(filePath: string): Promise<ApkInfo> {
  const { statSync } = await import('node:fs')
  let mtimeMs = 0
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    /* 交给 parseApk 报错 */
  }
  const hit = apkCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.info

  const info = await parseApk(filePath)
  apkCache.set(filePath, { info, mtimeMs })
  if (apkCache.size > 64) {
    const oldest = apkCache.keys().next().value
    if (oldest) apkCache.delete(oldest)
  }
  return info
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  /* --------------------------- 设备 --------------------------- */
  ipcMain.handle(IPC.deviceList, () => adb.getDevices())

  ipcMain.handle(IPC.deviceRefresh, async () => {
    await adb.refreshDevices()
    return adb.getDevices()
  })

  /* --------------------------- ADB ---------------------------- */
  ipcMain.handle(IPC.adbStatus, () => adb.getStatus())

  ipcMain.handle(IPC.adbRepair, async () => {
    await adb.repair()
    return adb.getStatus()
  })

  /* --------------------------- APK ---------------------------- */
  ipcMain.handle(IPC.apkPick, async (): Promise<string[]> => {
    if (!mainWindow) return []
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择 APK 安装包',
      buttonLabel: '选择',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Android 安装包', extensions: ['apk', 'apks', 'xapk'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.apkParse, async (_e, paths: unknown): Promise<ApkInfo[]> => {
    const list = Array.isArray(paths) ? (paths as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const out: ApkInfo[] = []
    for (const p of list.slice(0, 20)) {
      try {
        out.push(await parseApkCached(p))
      } catch (err) {
        out.push({
          filePath: p,
          fileName: path.basename(p),
          fileSize: 0,
          packageName: null,
          versionName: null,
          versionCode: null,
          minSdk: null,
          targetSdk: null,
          compileSdk: null,
          appLabel: null,
          iconDataUrl: null,
          nativeAbis: [],
          hasNativeLibs: false,
          debuggable: false,
          testOnly: false,
          isSplit: false,
          permissions: [],
          parseError: err instanceof Error ? err.message : String(err),
          parsedAt: Date.now()
        })
      }
    }
    return out
  })

  /* --------------------------- 安装 --------------------------- */
  ipcMain.handle(
    IPC.installStart,
    async (_e, payload: { deviceId: string; apkPath: string; options?: Partial<InstallOptions> }) => {
      const device = adb.getDevices().find((d) => d.id === payload.deviceId)
      if (!device) {
        return {
          taskId: '',
          ok: false,
          stage: 'failed',
          errorTitle: '设备已断开',
          errorDetail: '找不到目标设备，请重新连接后重试。',
          durationMs: 0
        } satisfies InstallResult
      }

      const apk = await parseApkCached(payload.apkPath)

      // 安装前再跑一次兼容性判定，防止用户在设备热插拔后直接点安装
      const report = evaluateCompat(apk, device)
      if (!report.installable) {
        const first = report.issues.find((i) => i.level === 'error')
        return {
          taskId: '',
          ok: false,
          stage: 'failed',
          errorTitle: first?.title ?? '兼容性检查未通过',
          errorDetail: first?.detail ?? '',
          packageName: apk.packageName,
          durationMs: 0
        } satisfies InstallResult
      }

      const s = settings.get()
      const options: InstallOptions = {
        replace: payload.options?.replace ?? s.replace,
        grantAll: payload.options?.grantAll ?? s.grantAll,
        allowDowngrade: payload.options?.allowDowngrade ?? s.allowDowngrade,
        allowTest: payload.options?.allowTest ?? s.allowTest,
        launchAfterInstall: payload.options?.launchAfterInstall ?? s.launchAfterInstall
      }

      const handle = installer.install(device, apk, options, (p: InstallProgress) => {
        send(IPC.installProgress, p)
      })
      runningTasks.set(handle.taskId, { cancel: handle.cancel })

      const result = await handle.result
      runningTasks.delete(handle.taskId)
      send(IPC.installResult, result)
      return result
    }
  )

  ipcMain.handle(IPC.installCancel, (_e, taskId: unknown) => {
    if (typeof taskId === 'string') runningTasks.get(taskId)?.cancel()
    return true
  })

  /* ------------------------ 启动已安装应用 ------------------------ */
  ipcMain.handle(IPC.appLaunch, async (_e, payload: { deviceId: string; packageName: string }) => {
    const device = adb.getDevices().find((d) => d.id === payload.deviceId)
    if (!device) return { ok: false, message: '设备已断开' }
    const ok = await installer.launch(device, payload.packageName)
    return { ok, message: ok ? '已启动' : '启动失败，该应用可能没有可启动的界面' }
  })

  /* ---------------------------- 应用管理 ---------------------------- */
  ipcMain.handle(IPC.appsList, async (_e, deviceId: unknown) => {
    const device = adb.getDevices().find((d) => d.id === deviceId)
    if (!device) return []
    try {
      return await appManager.list(device)
    } catch {
      return []
    }
  })

  ipcMain.handle(
    IPC.appsResolve,
    async (_e, payload: { deviceId: string; packageName: string; apkPath: string | null }) => {
      const device = adb.getDevices().find((d) => d.id === payload.deviceId)
      if (!device) return { packageName: payload.packageName, label: null, iconDataUrl: null, error: '设备已断开' }
      try {
        const info = await appManager.resolveDetails(device, {
          packageName: payload.packageName,
          apkPath: payload.apkPath
        })
        return {
          packageName: payload.packageName,
          label: info.appLabel,
          iconDataUrl: info.iconDataUrl,
          error: info.parseError
        }
      } catch (err) {
        return {
          packageName: payload.packageName,
          label: null,
          iconDataUrl: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  ipcMain.handle(
    IPC.appsRun,
    async (_e, payload: { deviceId: string; packageName: string; action: AppAction }) => {
      const device = adb.getDevices().find((d) => d.id === payload.deviceId)
      if (!device) {
        return { packageName: payload.packageName, action: payload.action, ok: false, message: '设备已断开' }
      }
      const r = await appManager.run(device, payload.packageName, payload.action)
      return { packageName: payload.packageName, action: payload.action, ...r }
    }
  )

  /* ---------------------------- 动态取色 ---------------------------- */
  ipcMain.handle(IPC.colorState, () => colorState)

  ipcMain.handle(IPC.colorRefresh, async () => {
    colorState = await computeDynamicColor(settings.get().dynamicColor)
    send(IPC.colorChanged, colorState)
    return colorState
  })

  /* --------------------------- 设置 --------------------------- */
  ipcMain.handle(IPC.getSettings, () => settings.get())

  ipcMain.handle(IPC.setSettings, (_e, patch: unknown) => {
    const next = settings.set((patch ?? {}) as Partial<AppSettings>)
    const p = (patch ?? {}) as Partial<AppSettings>
    if ('theme' in p) applyTheme(next.theme)
    if ('dynamicColor' in p) {
      void (async () => {
        colorState = await computeDynamicColor(next.dynamicColor)
        send(IPC.colorChanged, colorState)
      })()
    }
    if ('adbPathOverride' in p) {
      adb.adbPathOverride = next.adbPathOverride
      void (async () => {
        const ok = await adb.ensureServer()
        if (ok) {
          adb.startTracking()
          await adb.refreshDevices()
        }
      })()
    }
    return next
  })

  /* --------------------------- 系统 --------------------------- */
  ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  ipcMain.handle(IPC.revealFile, (_e, p: unknown) => {
    if (typeof p === 'string') shell.showItemInFolder(p)
    return true
  })

  ipcMain.handle(IPC.windowMinimize, () => {
    mainWindow?.minimize()
    return true
  })
  ipcMain.handle(IPC.windowMaximize, () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, () => {
    mainWindow?.close()
    return true
  })
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    settings = new SettingsStore()
    adb = new AdbManager({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      home: app.getPath('home')
    })
    adb.adbPathOverride = settings.get().adbPathOverride
    installer = new Installer(adb)
    appManager = new AppManager(adb)

    adb.on('devices', (devices: DeviceInfo[]) => send(IPC.deviceChanged, devices))
    adb.on('status', (status) => send(IPC.adbChanged, status))

    registerIpc()
    applyTheme(settings.get().theme)
    createWindow()

    // 壁纸取色与 ADB 初始化都不阻塞首屏
    void (async () => {
      colorState = await computeDynamicColor(settings.get().dynamicColor)
      send(IPC.colorChanged, colorState)
    })()

    void (async () => {
      const ok = await adb.ensureServer()
      if (ok) {
        await adb.refreshDevices()
        adb.startTracking()
      }
    })()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    adb?.dispose()
    if (process.platform !== 'darwin') app.quit()
  })
}
