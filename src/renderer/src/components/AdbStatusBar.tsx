import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import {
  Box,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { AnimatePresence, motion } from 'framer-motion'
import type { AdbStatus } from '@shared/types'
import { useTokens, type Tokens } from '../theme'
import { formatTime } from '../format'
import { StatusDot, type DotTone } from './StatusDot'

function toneOf(adb: AdbStatus | null): DotTone {
  if (!adb) return 'idle'
  if (adb.busy) return 'busy'
  return adb.available ? 'ok' : 'error'
}

function summary(adb: AdbStatus | null): string {
  if (!adb) return '正在检测 ADB 环境…'
  if (adb.busy) return '正在初始化 ADB 服务…'
  if (!adb.available) return adb.lastError ?? 'ADB 不可用'
  const parts = [`ADB ${adb.clientVersion ?? ''}`.trim(), `端口 ${adb.serverPort}`]
  if (adb.portConflict) parts.push('已自动避让端口冲突')
  if (adb.versionConflict) parts.push('已自动重启服务')
  return parts.join(' · ')
}

function logColor(level: string, t: Tokens): string {
  switch (level) {
    case 'fixed':
      return t.success
    case 'warn':
      return t.warning
    default:
      return t.info
  }
}

export function AdbStatusBar({
  adb,
  open,
  onToggle,
  onRepair
}: {
  adb: AdbStatus | null
  open: boolean
  onToggle: () => void
  onRepair: () => void
}) {
  const t = useTokens()
  const tone = toneOf(adb)
  const logs = adb?.logs ?? []

  return (
    <>
      <Box
        onClick={onToggle}
        role="button"
        tabIndex={0}
        sx={{
          height: 38,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.75,
          borderTop: `1px solid ${t.outlineVariant}`,
          backgroundColor: t.surfaceContainerLow,
          cursor: 'pointer',
          transition: 'background-color 180ms cubic-bezier(0.2,0,0,1)',
          '&:hover': { backgroundColor: t.surfaceContainer }
        }}
      >
        <StatusDot tone={tone} size={7} pulse={tone === 'busy'} />
        <Typography
          sx={{
            fontSize: 12,
            color: adb?.available === false ? t.error : t.onSurfaceVariant,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1
          }}
        >
          {summary(adb)}
        </Typography>
        {logs.length > 0 && (
          <Typography sx={{ fontSize: 11.5, color: t.onSurfaceVariant, opacity: 0.75 }}>
            {logs.length} 条记录
          </Typography>
        )}
        <Box
          component={motion.div}
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          sx={{ display: 'flex', color: t.onSurfaceVariant }}
        >
          {open ? <ExpandMoreRoundedIcon sx={{ fontSize: 18 }} /> : <ExpandLessRoundedIcon sx={{ fontSize: 18 }} />}
        </Box>
      </Box>

      <Drawer
        anchor="bottom"
        open={open}
        onClose={onToggle}
        slotProps={{
          paper: {
            sx: {
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              border: `1px solid ${t.outlineVariant}`,
              backgroundColor: t.surfaceContainerHigh,
              maxHeight: '58vh',
              backgroundImage: 'none'
            }
          }
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2.5, pt: 2, pb: 1.5 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 650, color: t.onSurface, flex: 1 }}>
            ADB 环境与自动修复记录
          </Typography>
          <Tooltip title="重置 ADB 服务并重新扫描">
            <span>
              <IconButton size="small" onClick={onRepair} disabled={adb?.busy} sx={{ color: t.onSurfaceVariant }}>
                <RefreshRoundedIcon
                  fontSize="small"
                  sx={{ animation: adb?.busy ? 'apki-spin 1s linear infinite' : 'none' }}
                />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={onToggle} sx={{ color: t.onSurfaceVariant }}>
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Divider />

        <Box sx={{ px: 2.5, py: 1.75, overflowY: 'auto' }}>
          <Stack spacing={1} sx={{ mb: logs.length ? 2 : 0 }}>
            <InfoRow label="adb 路径" value={adb?.adbPath ?? '未找到'} mono />
            <InfoRow label="来源" value={sourceText(adb?.source ?? null)} />
            <InfoRow label="客户端版本" value={adb?.clientVersion ?? '—'} mono />
            <InfoRow label="服务端口" value={String(adb?.serverPort ?? 5037)} mono />
          </Stack>

          {logs.length === 0 ? (
            <Typography sx={{ fontSize: 12.5, color: t.onSurfaceVariant, py: 2 }}>
              暂无记录。插拔设备或点击右上角刷新按钮后，这里会显示 ADB 的自动处理过程。
            </Typography>
          ) : (
            <Stack spacing={1.25}>
              <AnimatePresence initial={false}>
                {[...logs].reverse().map((entry) => (
                  <Box
                    component={motion.div}
                    key={entry.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                    sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}
                  >
                    <Box
                      sx={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        mt: 0.75,
                        flex: '0 0 auto',
                        backgroundColor: logColor(entry.level, t)
                      }}
                    />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                        <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: t.onSurface }}>
                          {entry.title}
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: t.onSurfaceVariant, opacity: 0.7 }}>
                          {formatTime(entry.at)}
                        </Typography>
                      </Stack>
                      {entry.detail && (
                        <Typography
                          className="selectable"
                          sx={{ fontSize: 12, color: t.onSurfaceVariant, lineHeight: 1.6, mt: 0.25, wordBreak: 'break-all' }}
                        >
                          {entry.detail}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                ))}
              </AnimatePresence>
            </Stack>
          )}
        </Box>
      </Drawer>
    </>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const t = useTokens()
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
      <Typography sx={{ fontSize: 12, color: t.onSurfaceVariant, width: 84, flex: '0 0 auto' }}>{label}</Typography>
      <Typography
        className="selectable"
        sx={{
          fontSize: 12,
          color: t.onSurface,
          fontFamily: mono ? 'Consolas, "Cascadia Mono", monospace' : 'inherit',
          wordBreak: 'break-all',
          flex: 1
        }}
      >
        {value}
      </Typography>
    </Stack>
  )
}

function sourceText(s: string | null): string {
  switch (s) {
    case 'bundled':
      return '应用内置 platform-tools'
    case 'sdk':
      return 'Android SDK'
    case 'path':
      return '系统 PATH'
    case 'appdata':
      return '应用数据目录'
    case 'env':
      return '自定义路径'
    default:
      return '未确定'
  }
}
