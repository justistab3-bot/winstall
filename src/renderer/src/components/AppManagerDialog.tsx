import AppsRoundedIcon from '@mui/icons-material/AppsRounded'
import BlockRoundedIcon from '@mui/icons-material/BlockRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import ClearRoundedIcon from '@mui/icons-material/ClearRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import {
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppAction, DeviceInfo, InstalledApp } from '@shared/types'
import { useTokens } from '../theme'

type Filter = 'all' | 'user' | 'system'

/** 一次渲染多少行，滚到底再追加 —— 避免几百行一次性挂载造成卡顿 */
const PAGE = 60

interface Props {
  open: boolean
  device: DeviceInfo | null
  onClose: () => void
  onToast: (message: string, detail: string | undefined, severity: 'success' | 'error' | 'info' | 'warning') => void
}

export function AppManagerDialog({ open, device, onClose, onToast }: Props) {
  const t = useTokens()
  const [apps, setApps] = useState<InstalledApp[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [busyPkg, setBusyPkg] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; app: InstalledApp } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    if (!device) return
    setLoading(true)
    try {
      const list = await window.api.listApps(device.id)
      setApps(list)
      setVisible(PAGE)
    } finally {
      setLoading(false)
    }
  }, [device])

  useEffect(() => {
    if (open && device) void load()
  }, [open, device, load])

  // 关闭时清掉菜单，避免下次打开残留
  useEffect(() => {
    if (!open) setMenu(null)
  }, [open])

  const counts = useMemo(() => {
    let user = 0
    let system = 0
    for (const a of apps) (a.isSystem ? system++ : user++)
    return { all: apps.length, user, system }
  }, [apps])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return apps.filter((a) => {
      if (filter === 'user' && a.isSystem) return false
      if (filter === 'system' && !a.isSystem) return false
      if (!q) return true
      return (
        a.packageName.toLowerCase().includes(q) ||
        (a.label ?? '').toLowerCase().includes(q)
      )
    })
  }, [apps, filter, query])

  const shown = filtered.slice(0, visible)

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
        setVisible((v) => (v < filtered.length ? v + PAGE : v))
      }
    },
    [filtered.length]
  )

  useEffect(() => {
    setVisible(PAGE)
  }, [filter, query])

  const runAction = useCallback(
    async (app: InstalledApp, action: AppAction) => {
      if (!device) return
      setMenu(null)
      setBusyPkg(app.packageName)
      try {
        const r = await window.api.runAppAction(device.id, app.packageName, action)
        onToast(r.message, app.label ?? app.packageName, r.ok ? 'success' : 'error')
        // 卸载/停用会改变列表状态，重新拉一次
        if (r.ok && (action === 'uninstall' || action === 'disable' || action === 'enable')) {
          await load()
        }
      } finally {
        setBusyPkg(null)
      }
    },
    [device, load, onToast]
  )

  /** 按需解析应用名与图标：只对用户主动指定的应用做，避免批量拉包卡死 */
  const resolveOne = useCallback(
    async (app: InstalledApp) => {
      if (!device) return
      setBusyPkg(app.packageName)
      try {
        const r = await window.api.resolveApp(device.id, app.packageName, app.apkPath)
        setApps((prev) =>
          prev.map((a) =>
            a.packageName === app.packageName ? { ...a, label: r.label, iconDataUrl: r.iconDataUrl } : a
          )
        )
        if (!r.label) onToast('未能解析出应用名', r.error ?? '该应用可能没有本地化名称', 'warning')
      } finally {
        setBusyPkg(null)
      }
    },
    [device, onToast]
  )

  /** 批量解析「用户应用」的名称 —— 数量通常很少，但仍限制上限并显示进度 */
  const resolveUserApps = useCallback(async () => {
    if (!device) return
    const targets = apps.filter((a) => !a.isSystem && !a.label).slice(0, 12)
    if (targets.length === 0) {
      onToast('没有需要解析的应用', '用户应用的名称都已解析，或设备上没有用户应用', 'info')
      return
    }
    setResolving(true)
    let done = 0
    try {
      for (const app of targets) {
        const r = await window.api.resolveApp(device.id, app.packageName, app.apkPath)
        setApps((prev) =>
          prev.map((a) =>
            a.packageName === app.packageName ? { ...a, label: r.label, iconDataUrl: r.iconDataUrl } : a
          )
        )
        done++
      }
      onToast(`已解析 ${done} 个应用名称`, undefined, 'success')
    } finally {
      setResolving(false)
    }
  }, [apps, device, onToast])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: '78vh' } } }}>
      {/* 头部 */}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, pt: 2.5, pb: 1.5 }}>
        <Box
          sx={{
            width: 36,
            height: 36,
            borderRadius: '11px',
            display: 'grid',
            placeItems: 'center',
            backgroundColor: t.primaryContainer,
            color: t.onPrimaryContainer,
            flex: '0 0 auto'
          }}
        >
          <AppsRoundedIcon sx={{ fontSize: 20 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 18, fontWeight: 650, color: t.onSurface }}>管理应用</Typography>
          <Typography sx={{ fontSize: 12, color: t.onSurfaceVariant }}>
            {device ? `${device.model || device.id} · 共 ${counts.all} 个应用` : '未连接设备'}
          </Typography>
        </Box>
        <Tooltip title="重新读取应用列表">
          <span>
            <IconButton size="small" onClick={() => void load()} disabled={loading} sx={{ color: t.onSurfaceVariant }}>
              <RefreshRoundedIcon fontSize="small" sx={{ animation: loading ? 'apki-spin 1s linear infinite' : 'none' }} />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={onClose} sx={{ color: t.onSurfaceVariant }}>
          <ClearRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Divider />

      {/* 筛选栏 */}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 1.5 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={filter}
          onChange={(_e, v) => v && setFilter(v)}
          sx={{
            '& .MuiToggleButton-root': {
              px: 1.5,
              py: 0.4,
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'none',
              borderRadius: '100px !important',
              borderColor: t.outlineVariant,
              color: t.onSurfaceVariant,
              '&.Mui-selected': { backgroundColor: t.primaryContainer, color: t.onPrimaryContainer }
            }
          }}
        >
          <ToggleButton value="all">全部 {counts.all}</ToggleButton>
          <ToggleButton value="user">用户 {counts.user}</ToggleButton>
          <ToggleButton value="system">系统 {counts.system}</ToggleButton>
        </ToggleButtonGroup>

        <Box sx={{ flex: 1 }} />

        <Tooltip title="逐个读取 APK 解析出应用名（较慢，仅对用户应用）">
          <span>
            <IconButton size="small" onClick={() => void resolveUserApps()} disabled={resolving || loading} sx={{ color: t.onSurfaceVariant }}>
              <DownloadRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <TextField
          size="small"
          placeholder="搜索包名或应用名"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRoundedIcon sx={{ fontSize: 17, color: t.onSurfaceVariant }} />
                </InputAdornment>
              )
            }
          }}
          sx={{
            width: 220,
            '& .MuiOutlinedInput-root': {
              borderRadius: '100px',
              fontSize: 12.5,
              backgroundColor: t.surfaceContainer,
              '& fieldset': { borderColor: t.outlineVariant }
            }
          }}
        />
      </Stack>

      {resolving && <LinearProgress sx={{ mx: 3, mb: 1 }} />}

      <Divider />

      {/* 列表 */}
      <DialogContent ref={scrollRef} onScroll={onScroll} sx={{ p: 0, backgroundColor: t.surfaceContainerLowest }}>
        {loading && apps.length === 0 ? (
          <Stack spacing={1.5} sx={{ p: 3 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <Box key={i} sx={{ height: 46, borderRadius: '10px', backgroundColor: t.surfaceContainer }} />
            ))}
          </Stack>
        ) : filtered.length === 0 ? (
          <Stack spacing={1} sx={{ alignItems: 'center', py: 8 }}>
            <AppsRoundedIcon sx={{ fontSize: 34, color: t.onSurfaceVariant, opacity: 0.5 }} />
            <Typography sx={{ fontSize: 13, color: t.onSurfaceVariant }}>
              {apps.length === 0 ? '没有读取到应用' : '没有匹配的应用'}
            </Typography>
          </Stack>
        ) : (
          <Box sx={{ py: 1 }}>
            {/*
              这里刻意不使用 AnimatePresence：
              筛选/搜索会一次性移除几十上百行，退出动画会让被过滤掉的行
              在视觉上滞留好几秒（行数越多越明显），列表看起来像没反应。
              列表的即时性比退场动画重要得多。
            */}
            {shown.map((app) => (
              <AppRow
                key={app.packageName}
                app={app}
                busy={busyPkg === app.packageName}
                onMenu={(anchor) => setMenu({ anchor, app })}
                onResolve={() => void resolveOne(app)}
              />
            ))}
            {visible < filtered.length && (
              <Typography sx={{ fontSize: 12, color: t.onSurfaceVariant, textAlign: 'center', py: 2 }}>
                还有 {filtered.length - visible} 个，继续滚动加载…
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>

      {/* 操作菜单 */}
      <Menu
        anchorEl={menu?.anchor ?? null}
        open={!!menu}
        onClose={() => setMenu(null)}
        slotProps={{ paper: { sx: { borderRadius: '14px', minWidth: 180, border: `1px solid ${t.outlineVariant}` } } }}
      >
        <MenuItem onClick={() => menu && void runAction(menu.app, 'launch')} sx={{ fontSize: 13, gap: 1.25 }}>
          <PlayArrowRoundedIcon sx={{ fontSize: 18, color: t.onSurfaceVariant }} /> 打开
        </MenuItem>
        <MenuItem onClick={() => menu && void runAction(menu.app, 'forceStop')} sx={{ fontSize: 13, gap: 1.25 }}>
          <StopRoundedIcon sx={{ fontSize: 18, color: t.onSurfaceVariant }} /> 强制停止
        </MenuItem>
        <MenuItem
          onClick={() => menu && void runAction(menu.app, menu.app.isDisabled ? 'enable' : 'disable')}
          sx={{ fontSize: 13, gap: 1.25 }}
        >
          {menu?.app.isDisabled ? (
            <>
              <CheckCircleRoundedIcon sx={{ fontSize: 18, color: t.onSurfaceVariant }} /> 启用
            </>
          ) : (
            <>
              <BlockRoundedIcon sx={{ fontSize: 18, color: t.onSurfaceVariant }} /> 停用
            </>
          )}
        </MenuItem>
        <MenuItem onClick={() => menu && void runAction(menu.app, 'clearData')} sx={{ fontSize: 13, gap: 1.25 }}>
          <ClearRoundedIcon sx={{ fontSize: 18, color: t.onSurfaceVariant }} /> 清除数据
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => menu && void runAction(menu.app, 'uninstall')}
          sx={{ fontSize: 13, gap: 1.25, color: t.error }}
        >
          <DeleteOutlineRoundedIcon sx={{ fontSize: 18 }} /> 卸载
        </MenuItem>
      </Menu>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

function AppRow({
  app,
  busy,
  onMenu,
  onResolve
}: {
  app: InstalledApp
  busy: boolean
  onMenu: (anchor: HTMLElement) => void
  onResolve: () => void
}) {
  const t = useTokens()
  const hasLabel = !!app.label

  return (
    <Box
      data-app-row={app.packageName}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 3,
        py: 0.9,
        minHeight: 52,
        transition: 'background-color 160ms cubic-bezier(0.2,0,0,1)',
        '&:hover': { backgroundColor: t.surfaceContainer },
        opacity: app.isDisabled ? 0.55 : 1
      }}
    >
      {/* 图标：未解析时用首字母占位，不为了图标去拉 APK */}
      {app.iconDataUrl ? (
        <Box
          component="img"
          src={app.iconDataUrl}
          alt=""
          sx={{ width: 32, height: 32, borderRadius: '9px', flex: '0 0 auto', objectFit: 'contain' }}
        />
      ) : (
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: '9px',
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            backgroundColor: t.surfaceContainerHighest,
            color: t.onSurfaceVariant,
            fontSize: 14,
            fontWeight: 700
          }}
        >
          {(app.label || app.packageName).charAt(0).toUpperCase()}
        </Box>
      )}

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          className="selectable"
          sx={{
            fontSize: 13,
            fontWeight: hasLabel ? 600 : 500,
            color: hasLabel ? t.onSurface : t.onSurfaceVariant,
            fontFamily: hasLabel ? 'inherit' : 'Consolas, "Cascadia Mono", monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {app.label ?? app.packageName}
        </Typography>
        {hasLabel && (
          <Typography
            className="selectable"
            sx={{
              fontSize: 11.5,
              color: t.onSurfaceVariant,
              fontFamily: 'Consolas, "Cascadia Mono", monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {app.packageName}
            {app.versionCode != null ? ` · v${app.versionCode}` : ''}
          </Typography>
        )}
      </Box>

      {app.isSystem && (
        <Chip
          size="small"
          label="系统"
          sx={{ backgroundColor: t.surfaceContainerHighest, color: t.onSurfaceVariant, height: 20, fontSize: 11 }}
        />
      )}
      {app.isDisabled && (
        <Chip size="small" label="已停用" sx={{ backgroundColor: `${t.warning}22`, color: t.warning, height: 20, fontSize: 11 }} />
      )}

      {!hasLabel && (
        <Tooltip title="读取 APK 解析应用名与图标">
          <span>
            <IconButton size="small" disabled={busy} onClick={onResolve} sx={{ color: t.onSurfaceVariant }}>
              {busy ? <CircularProgress size={15} /> : <DownloadRoundedIcon sx={{ fontSize: 17 }} />}
            </IconButton>
          </span>
        </Tooltip>
      )}

      <IconButton
        size="small"
        disabled={busy}
        onClick={(e) => onMenu(e.currentTarget)}
        sx={{ color: t.onSurfaceVariant }}
      >
        {busy ? <CircularProgress size={15} /> : <MoreVertRoundedIcon sx={{ fontSize: 18 }} />}
      </IconButton>
    </Box>
  )
}
