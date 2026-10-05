import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { Alert, Box, Chip, CssBaseline, Snackbar, Stack, ThemeProvider, Typography } from '@mui/material'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { evaluateCompat } from '@shared/compat'
import type {
  AdbStatus,
  ApkInfo,
  AppSettings,
  DeviceInfo,
  DynamicColorState,
  InstallProgress,
  InstallResult
} from '@shared/types'
import { AdbStatusBar } from './components/AdbStatusBar'
import { ApkCard } from './components/ApkCard'
import { AppManagerDialog } from './components/AppManagerDialog'
import { DeviceCard, DeviceEmpty } from './components/DeviceCard'
import { DropZone } from './components/DropZone'
import { SettingsDialog } from './components/SettingsDialog'
import { TitleBar } from './components/TitleBar'
import { formatDuration } from './format'
import { getTheme, tokensFor, TokensProvider, useTokens } from './theme'

interface Toast {
  message: string
  detail?: string
  severity: 'success' | 'error' | 'warning' | 'info'
}

const APK_RE = /\.(apk|apks|xapk)$/i

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adb, setAdb] = useState<AdbStatus | null>(null)
  const [color, setColor] = useState<DynamicColorState | null>(null)
  const [apks, setApks] = useState<ApkInfo[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [dragging, setDragging] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appsOpen, setAppsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [lastInstalled, setLastInstalled] = useState<{ packageName: string; label: string } | null>(null)
  const [batch, setBatch] = useState<{ running: boolean; index: number; total: number }>({
    running: false,
    index: 0,
    total: 0
  })
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )

  const clearTimer = useRef<number | null>(null)
  const installingRef = useRef(false)

  /* ----------------------------- 初始化 ----------------------------- */

  useEffect(() => {
    let alive = true
    void (async () => {
      const [s, d, a, c] = await Promise.all([
        window.api.getSettings(),
        window.api.listDevices(),
        window.api.adbStatus(),
        window.api.colorState()
      ])
      if (!alive) return
      setSettings(s)
      setDevices(d)
      setAdb(a)
      setColor(c)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => window.api.onDevices(setDevices), [])
  useEffect(() => window.api.onAdbStatus(setAdb), [])
  useEffect(() => window.api.onInstallProgress(setProgress), [])
  useEffect(() => window.api.onColorChanged(setColor), [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // 设备增删后自动选中一台
  useEffect(() => {
    if (devices.length === 0) {
      setSelectedId(null)
      return
    }
    setSelectedId((prev) => (prev && devices.some((d) => d.id === prev) ? prev : devices[0].id))
  }, [devices])

  /* ----------------------------- 派生状态 ----------------------------- */

  const dark = settings?.theme === 'dark' || (settings?.theme !== 'light' && systemDark)
  const mode = dark ? 'dark' : 'light'
  const tokens = useMemo(() => tokensFor(mode, color?.seed ?? null), [mode, color?.seed])
  const theme = useMemo(() => getTheme(mode, tokens), [mode, tokens])

  const device = useMemo(
    () => devices.find((d) => d.id === selectedId) ?? devices[0] ?? null,
    [devices, selectedId]
  )

  const apk = apks[activeIndex] ?? null
  const report = useMemo(() => evaluateCompat(apk, device), [apk, device])

  const installing = !!progress && progress.stage !== 'success' && progress.stage !== 'failed'
  const installedPkg =
    lastInstalled && apk?.packageName && lastInstalled.packageName === apk.packageName
      ? lastInstalled
      : null

  /* ----------------------------- 交互 ----------------------------- */

  const loadPaths = useCallback(async (paths: string[]) => {
    const apkPaths = paths.filter((p) => APK_RE.test(p))
    const skipped = paths.length - apkPaths.length
    if (apkPaths.length === 0) {
      setToast({
        message: '这不是安装包',
        detail: '请拖入 .apk 文件（也支持 .apks / .xapk）。',
        severity: 'warning'
      })
      return
    }
    const parsed = await window.api.parseApk(apkPaths)
    const usable = parsed.filter((p) => !p.parseError || p.packageName)
    setApks(usable)
    setActiveIndex(0)
    setProgress(null)
    setLastInstalled(null)

    if (skipped > 0) {
      setToast({
        message: `已载入 ${usable.length} 个安装包`,
        detail: `忽略了 ${skipped} 个非 APK 文件。`,
        severity: 'info'
      })
    } else if (usable.length > 1) {
      setToast({
        message: `已载入 ${usable.length} 个安装包`,
        detail: usable.length > 1 && settings?.batchInstall ? '将按顺序依次安装' : undefined,
        severity: 'info'
      })
    }
  }, [settings?.batchInstall])

  const handlePick = useCallback(async () => {
    const paths = await window.api.pickApk()
    if (paths.length > 0) await loadPaths(paths)
  }, [loadPaths])

  // 全窗口拖放：用计数器抵消子元素冒泡产生的 dragleave
  useEffect(() => {
    let depth = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      depth += 1
      if (e.dataTransfer?.types?.includes('Files')) setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      depth -= 1
      if (depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean)
      if (paths.length > 0) void loadPaths(paths)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [loadPaths])

  /**
   * 安装。拖入多个包且开启了批量安装时，会依次把后续的也装完。
   * 任何一步失败都会中断队列并把原因抛给用户 —— 静默跳过更糟。
   */
  const handleInstall = useCallback(async () => {
    if (!device || apks.length === 0 || installingRef.current) return
    installingRef.current = true

    const autoContinue = apks.length > 1 && (settings?.batchInstall ?? true)
    let idx = activeIndex
    setBatch({ running: autoContinue, index: idx + 1, total: apks.length })

    try {
      for (;;) {
        const target = apks[idx]
        if (!target) break
        setActiveIndex(idx)
        setBatch((b) => ({ ...b, index: idx + 1 }))

        setProgress({
          taskId: '',
          stage: 'preparing',
          percent: 0,
          indeterminate: true,
          message:
            autoContinue && apks.length > 1
              ? `正在准备第 ${idx + 1} / ${apks.length} 个安装包…`
              : '正在准备安装环境…'
        })

        const result: InstallResult = await window.api.install({
          deviceId: device.id,
          apkPath: target.filePath
        })

        if (result.ok) {
          const label = target.appLabel ?? target.packageName ?? target.fileName
          setLastInstalled({ packageName: target.packageName ?? '', label })
          setToast({
            message: autoContinue && apks.length > 1 ? `第 ${idx + 1} 个安装成功` : '安装成功',
            detail: `${label} 已安装到 ${device.model || device.id} · 耗时 ${formatDuration(result.durationMs)}`,
            severity: 'success'
          })
        } else {
          setToast({
            message: result.errorTitle ?? '安装失败',
            detail:
              autoContinue && apks.length > 1
                ? `${target.appLabel ?? target.packageName ?? target.fileName}：${result.errorDetail ?? ''}`
                : result.errorDetail,
            severity: 'error'
          })
          if (clearTimer.current) window.clearTimeout(clearTimer.current)
          clearTimer.current = window.setTimeout(() => setProgress(null), 700)
          break
        }

        const isLast = idx >= apks.length - 1
        if (!autoContinue || isLast) {
          if (clearTimer.current) window.clearTimeout(clearTimer.current)
          clearTimer.current = window.setTimeout(() => setProgress(null), 1200)
          break
        }
        idx += 1
      }
    } finally {
      installingRef.current = false
      setBatch({ running: false, index: 0, total: 0 })
    }
  }, [device, apks, activeIndex, settings?.batchInstall])

  const handleCancel = useCallback(async () => {
    if (progress?.taskId) await window.api.cancelInstall(progress.taskId)
  }, [progress])

  const handleOpenApp = useCallback(async () => {
    if (!device || !installedPkg) return
    const r = await window.api.launchInstalled(device.id, installedPkg.packageName)
    if (!r.ok) setToast({ message: '打开失败', detail: r.message, severity: 'warning' })
  }, [device, installedPkg])

  const handleRepair = useCallback(async () => {
    setAdb((prev) => (prev ? { ...prev, busy: true } : prev))
    await window.api.adbRepair()
  }, [])

  const handleSettingsChange = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.api.setSettings(patch)
    setSettings(next)
  }, [])

  useEffect(() => {
    return () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
    }
  }, [])

  const showToast = useCallback(
    (message: string, detail: string | undefined, severity: Toast['severity']) =>
      setToast({ message, detail, severity }),
    []
  )

  /* ----------------------------- 渲染 ----------------------------- */

  return (
    <TokensProvider tokens={tokens}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Shell
          dark={dark}
          color={color}
          settings={settings}
          adb={adb}
          devices={devices}
          device={device}
          apks={apks}
          activeIndex={activeIndex}
          apk={apk}
          report={report}
          progress={progress}
          installing={installing}
          installedPkg={installedPkg}
          batch={batch}
          dragging={dragging}
          settingsOpen={settingsOpen}
          appsOpen={appsOpen}
          logsOpen={logsOpen}
          toast={toast}
          onToggleTheme={() => void handleSettingsChange({ theme: dark ? 'light' : 'dark' })}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={() => setSettingsOpen(false)}
          onOpenApps={() => setAppsOpen(true)}
          onCloseApps={() => setAppsOpen(false)}
          onToggleLogs={() => setLogsOpen((v) => !v)}
          onPick={handlePick}
          onSelectDevice={setSelectedId}
          onSelectApk={(i) => {
            setActiveIndex(i)
            setProgress(null)
          }}
          onClearApk={() => {
            setApks([])
            setProgress(null)
            setLastInstalled(null)
          }}
          onInstall={handleInstall}
          onOpenApp={handleOpenApp}
          onCancel={handleCancel}
          onRepair={handleRepair}
          onSettingsChange={handleSettingsChange}
          onCloseToast={() => setToast(null)}
          onToast={showToast}
        />
      </ThemeProvider>
    </TokensProvider>
  )
}

/* ------------------------------------------------------------------ */
/* 布局外壳                                                            */
/* ------------------------------------------------------------------ */

interface ShellProps {
  dark: boolean
  color: DynamicColorState | null
  settings: AppSettings | null
  adb: AdbStatus | null
  devices: DeviceInfo[]
  device: DeviceInfo | null
  apks: ApkInfo[]
  activeIndex: number
  apk: ApkInfo | null
  report: ReturnType<typeof evaluateCompat>
  progress: InstallProgress | null
  installing: boolean
  installedPkg: { packageName: string; label: string } | null
  batch: { running: boolean; index: number; total: number }
  dragging: boolean
  settingsOpen: boolean
  appsOpen: boolean
  logsOpen: boolean
  toast: Toast | null
  onToggleTheme: () => void
  onOpenSettings: () => void
  onCloseSettings: () => void
  onOpenApps: () => void
  onCloseApps: () => void
  onToggleLogs: () => void
  onPick: () => void
  onSelectDevice: (id: string) => void
  onSelectApk: (index: number) => void
  onClearApk: () => void
  onInstall: () => void
  onOpenApp: () => void
  onCancel: () => void
  onRepair: () => void
  onSettingsChange: (patch: Partial<AppSettings>) => void
  onCloseToast: () => void
  onToast: (message: string, detail: string | undefined, severity: Toast['severity']) => void
}

function Shell(p: ShellProps) {
  const t = useTokens()

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: t.surface,
        position: 'relative',
        overflow: 'hidden',
        transition: 'background-color 320ms cubic-bezier(0.2,0,0,1)'
      }}
    >
      <TitleBar
        adb={p.adb}
        dark={p.dark}
        onToggleTheme={p.onToggleTheme}
        onOpenSettings={p.onOpenSettings}
        onOpenLogs={p.onToggleLogs}
      />

      <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', px: 3, py: 2.5 }}>
        <Stack spacing={2} sx={{ maxWidth: 860, mx: 'auto', pb: 2 }}>
          {/* 多设备选择：只有一台时完全不出现，保持简洁 */}
          <AnimatePresence>
            {p.devices.length > 1 && (
              <Box
                component={motion.div}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                sx={{ overflow: 'hidden' }}
              >
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, pb: 0.5 }}>
                  {p.devices.map((d) => (
                    <Chip
                      key={d.id}
                      label={d.model || (d.serialMissing ? '未知设备' : d.serial)}
                      onClick={() => p.onSelectDevice(d.id)}
                      sx={{
                        backgroundColor: d.id === p.device?.id ? t.primaryContainer : t.surfaceContainerHigh,
                        color: d.id === p.device?.id ? t.onPrimaryContainer : t.onSurfaceVariant,
                        border: `1px solid ${d.id === p.device?.id ? 'transparent' : t.outlineVariant}`,
                        cursor: 'pointer'
                      }}
                    />
                  ))}
                </Stack>
              </Box>
            )}
          </AnimatePresence>

          {/* 设备区 */}
          <AnimatePresence mode="popLayout" initial={false}>
            {p.device ? (
              <DeviceCard key={p.device.id} device={p.device} onManageApps={p.onOpenApps} />
            ) : (
              <DeviceEmpty key="empty" onRepair={p.onRepair} busy={!!p.adb?.busy} />
            )}
          </AnimatePresence>

          {/* 已载入的多个安装包：只有多于一个时才出现 */}
          <AnimatePresence>
            {p.apks.length > 1 && (
              <Box
                component={motion.div}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                sx={{ overflow: 'hidden' }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
                  {p.apks.map((a, i) => (
                    <Chip
                      key={a.filePath + i}
                      label={`${i + 1}. ${a.appLabel || a.packageName || a.fileName}`}
                      onClick={() => p.onSelectApk(i)}
                      sx={{
                        backgroundColor: i === p.activeIndex ? t.primaryContainer : t.surfaceContainerHigh,
                        color: i === p.activeIndex ? t.onPrimaryContainer : t.onSurfaceVariant,
                        border: `1px solid ${i === p.activeIndex ? 'transparent' : t.outlineVariant}`,
                        cursor: 'pointer'
                      }}
                    />
                  ))}
                </Stack>
              </Box>
            )}
          </AnimatePresence>

          {/* 安装包区：拖拽区与 APK 卡片互相切换 */}
          <AnimatePresence mode="popLayout" initial={false}>
            {p.apk ? (
              <ApkCard
                key="apk"
                apk={p.apk}
                report={p.report}
                device={p.device}
                progress={p.progress}
                installed={!!p.installedPkg}
                batch={p.batch}
                onInstall={p.onInstall}
                onOpenApp={p.onOpenApp}
                onCancel={p.onCancel}
                onClear={p.onClearApk}
                onPick={p.onPick}
              />
            ) : (
              <DropZone key="drop" onPick={p.onPick} dragging={p.dragging} />
            )}
          </AnimatePresence>
        </Stack>
      </Box>

      <AdbStatusBar adb={p.adb} open={p.logsOpen} onToggle={p.onToggleLogs} onRepair={p.onRepair} />

      {/* 全窗口拖放提示：已载入 APK 时拖入新文件也能得到明确反馈 */}
      <AnimatePresence>
        {p.dragging && p.apk && (
          <Box
            component={motion.div}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            sx={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              borderRadius: '16px',
              border: `2px solid ${t.primary}`,
              boxShadow: `inset 0 0 0 9999px ${t.primary}0D`
            }}
          >
            <Stack
              direction="row"
              spacing={1}
              sx={{
                position: 'absolute',
                top: 62,
                left: '50%',
                transform: 'translateX(-50%)',
                px: 2,
                py: 1,
                borderRadius: 100,
                backgroundColor: t.primary,
                color: t.onPrimary,
                alignItems: 'center',
                boxShadow: `0 8px 28px ${t.shadow}`
              }}
            >
              <Inventory2RoundedIcon sx={{ fontSize: 17 }} />
              <Typography sx={{ fontSize: 12.5, fontWeight: 650 }}>松开以载入新的安装包</Typography>
            </Stack>
          </Box>
        )}
      </AnimatePresence>

      <SettingsDialog
        open={p.settingsOpen}
        settings={p.settings}
        device={p.device}
        color={p.color}
        onChange={p.onSettingsChange}
        onClose={p.onCloseSettings}
      />

      <AppManagerDialog
        open={p.appsOpen}
        device={p.device}
        onClose={p.onCloseApps}
        onToast={p.onToast}
      />

      <Snackbar
        open={!!p.toast}
        autoHideDuration={p.toast?.severity === 'error' ? 9000 : 4200}
        onClose={p.onCloseToast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ mb: 6 }}
      >
        <Alert
          severity={p.toast?.severity ?? 'info'}
          variant="filled"
          onClose={p.onCloseToast}
          slots={{ closeIcon: CloseRoundedIcon }}
          slotProps={{ closeIcon: { sx: { fontSize: 16 } } }}
          sx={{ minWidth: 320, maxWidth: 560, alignItems: 'flex-start', py: 0.75 }}
        >
          <Typography sx={{ fontSize: 13.5, fontWeight: 650 }}>{p.toast?.message}</Typography>
          {p.toast?.detail && (
            <Typography sx={{ fontSize: 12.5, mt: 0.25, lineHeight: 1.6, opacity: 0.95 }}>
              {p.toast.detail}
            </Typography>
          )}
        </Alert>
      </Snackbar>
    </Box>
  )
}
