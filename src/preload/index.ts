import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type AdbStatus,
  type ApkInfo,
  type AppAction,
  type AppActionResult,
  type AppSettings,
  type DeviceInfo,
  type DynamicColorState,
  type InstallOptions,
  type InstallProgress,
  type InstallResult,
  type InstalledApp
} from '@shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /* 设备 */
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke(IPC.deviceList),
  refreshDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke(IPC.deviceRefresh),
  onDevices: (cb: (d: DeviceInfo[]) => void): Unsubscribe => on(IPC.deviceChanged, cb),

  /* APK */
  pickApk: (): Promise<string[]> => ipcRenderer.invoke(IPC.apkPick),
  parseApk: (paths: string[]): Promise<ApkInfo[]> => ipcRenderer.invoke(IPC.apkParse, paths),

  /**
   * Electron 32+ 移除了 File.path，拖拽文件必须经 webUtils 取真实路径。
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /* 安装 */
  install: (payload: {
    deviceId: string
    apkPath: string
    options?: Partial<InstallOptions>
  }): Promise<InstallResult> => ipcRenderer.invoke(IPC.installStart, payload),
  cancelInstall: (taskId: string): Promise<boolean> => ipcRenderer.invoke(IPC.installCancel, taskId),
  onInstallProgress: (cb: (p: InstallProgress) => void): Unsubscribe => on(IPC.installProgress, cb),
  onInstallResult: (cb: (r: InstallResult) => void): Unsubscribe => on(IPC.installResult, cb),
  launchInstalled: (deviceId: string, packageName: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.appLaunch, { deviceId, packageName }),

  /* 应用管理 */
  listApps: (deviceId: string): Promise<InstalledApp[]> => ipcRenderer.invoke(IPC.appsList, deviceId),
  resolveApp: (
    deviceId: string,
    packageName: string,
    apkPath: string | null
  ): Promise<{ packageName: string; label: string | null; iconDataUrl: string | null; error: string | null }> =>
    ipcRenderer.invoke(IPC.appsResolve, { deviceId, packageName, apkPath }),
  runAppAction: (deviceId: string, packageName: string, action: AppAction): Promise<AppActionResult> =>
    ipcRenderer.invoke(IPC.appsRun, { deviceId, packageName, action }),

  /* 动态取色 */
  colorState: (): Promise<DynamicColorState> => ipcRenderer.invoke(IPC.colorState),
  refreshColor: (): Promise<DynamicColorState> => ipcRenderer.invoke(IPC.colorRefresh),
  onColorChanged: (cb: (s: DynamicColorState) => void): Unsubscribe => on(IPC.colorChanged, cb),

  /* ADB */
  adbStatus: (): Promise<AdbStatus> => ipcRenderer.invoke(IPC.adbStatus),
  adbRepair: (): Promise<AdbStatus> => ipcRenderer.invoke(IPC.adbRepair),
  onAdbStatus: (cb: (s: AdbStatus) => void): Unsubscribe => on(IPC.adbChanged, cb),

  /* 设置 */
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.setSettings, patch),

  /* 主题 */
  onThemeChanged: (cb: (t: { shouldUseDarkColors: boolean; source: string }) => void): Unsubscribe =>
    on('theme:changed', cb),

  /* 窗口 */
  onWindowState: (cb: (maximized: boolean) => void): Unsubscribe => on('win:state', cb),
  minimize: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowMaximize),
  close: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowClose),

  /* 系统 */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.openExternal, url),
  revealFile: (p: string): Promise<boolean> => ipcRenderer.invoke(IPC.revealFile, p)
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
