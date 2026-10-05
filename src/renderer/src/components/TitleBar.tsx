import AndroidRoundedIcon from '@mui/icons-material/AndroidRounded'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded'
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { motion } from 'framer-motion'
import type { AdbStatus } from '@shared/types'
import { useTokens } from '../theme'
import { StatusDot, type DotTone } from './StatusDot'

interface Props {
  adb: AdbStatus | null
  dark: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenLogs: () => void
}

/** 原生窗口按钮（最小化/最大化/关闭）由 titleBarOverlay 绘制，这里要留出它们的宽度 */
const NATIVE_CONTROLS_WIDTH = 146

export function TitleBar({ adb, dark, onToggleTheme, onOpenSettings, onOpenLogs }: Props) {
  const t = useTokens()

  const tone: DotTone = adb?.busy
    ? 'busy'
    : !adb
      ? 'idle'
      : adb.available
        ? 'ok'
        : 'error'
  const label = adb?.busy ? '正在初始化' : !adb ? '检测中' : adb.available ? 'ADB 就绪' : 'ADB 异常'

  return (
    <Box
      className="app-drag"
      sx={{
        height: 48,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        pl: 1.75,
        pr: `${NATIVE_CONTROLS_WIDTH}px`,
        borderBottom: `1px solid ${t.outlineVariant}`,
        backgroundColor: t.surface
      }}
    >
      <Box
        component={motion.div}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 26 }}
        sx={{
          width: 28,
          height: 28,
          borderRadius: '9px',
          display: 'grid',
          placeItems: 'center',
          background: `linear-gradient(135deg, ${t.primaryContainer}, ${t.primary}44)`,
          color: t.onPrimaryContainer,
          flex: '0 0 auto'
        }}
      >
        <AndroidRoundedIcon sx={{ fontSize: 19 }} />
      </Box>

      <Typography
        sx={{
          fontSize: 14,
          fontWeight: 650,
          letterSpacing: '-0.01em',
          color: t.onSurface,
          whiteSpace: 'nowrap'
        }}
      >
        Winstall
      </Typography>

      <Box sx={{ flex: 1 }} />

      {/* ADB 状态胶囊：点击展开诊断日志 */}
      <Box
        className="app-no-drag"
        onClick={onOpenLogs}
        role="button"
        tabIndex={0}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.875,
          height: 30,
          px: 1.25,
          borderRadius: 100,
          cursor: 'pointer',
          backgroundColor: t.surfaceContainer,
          border: `1px solid ${t.outlineVariant}`,
          transition: 'background-color 180ms cubic-bezier(0.2,0,0,1)',
          '&:hover': { backgroundColor: t.surfaceContainerHigh }
        }}
      >
        <StatusDot tone={tone} size={7} pulse={tone === 'busy'} />
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: t.onSurfaceVariant, whiteSpace: 'nowrap' }}>
          {label}
        </Typography>
        <TerminalRoundedIcon sx={{ fontSize: 14, color: t.onSurfaceVariant, opacity: 0.7 }} />
      </Box>

      <Stack direction="row" className="app-no-drag" sx={{ gap: 0.25 }}>
        <Tooltip title={dark ? '切换到浅色' : '切换到深色'}>
          <IconButton size="small" onClick={onToggleTheme} sx={{ color: t.onSurfaceVariant }}>
            {dark ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="设置">
          <IconButton size="small" onClick={onOpenSettings} sx={{ color: t.onSurfaceVariant }}>
            <SettingsRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}
