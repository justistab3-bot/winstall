import AppsRoundedIcon from '@mui/icons-material/AppsRounded'
import MemoryRoundedIcon from '@mui/icons-material/MemoryRounded'
import PhoneAndroidRoundedIcon from '@mui/icons-material/PhoneAndroidRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import UsbRoundedIcon from '@mui/icons-material/UsbRounded'
import { Box, Button, Chip, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import { AnimatePresence, motion } from 'framer-motion'
import type { DeviceInfo, DeviceState } from '@shared/types'
import { useTokens } from '../theme'
import { formatBytes } from '../format'
import { StatusDot, type DotTone } from './StatusDot'

const STATE_TEXT: Record<DeviceState, string> = {
  device: '已连接',
  unauthorized: '未授权',
  offline: '离线',
  connecting: '握手中',
  recovery: 'Recovery',
  sideload: 'Sideload',
  bootloader: 'Bootloader',
  unknown: '未知状态'
}

const STATE_TONE: Record<DeviceState, DotTone> = {
  device: 'ok',
  unauthorized: 'warn',
  offline: 'error',
  connecting: 'busy',
  recovery: 'warn',
  sideload: 'warn',
  bootloader: 'warn',
  unknown: 'idle'
}

function bitnessLabel(device: DeviceInfo): string {
  switch (device.bitness) {
    case '32':
      return '32 位系统'
    case '64':
      return '64 位系统'
    case 'both':
      return '32 / 64 位'
    default:
      return '架构未知'
  }
}

/** 一个圆角小标签，用于展示架构/存储等元信息 */
function MetaChip({
  icon,
  label,
  emphasis = false
}: {
  icon?: React.ReactNode
  label: string
  emphasis?: boolean
}) {
  const t = useTokens()
  return (
    <Chip
      size="small"
      icon={icon ? <Box sx={{ display: 'flex', ml: 0.75 }}>{icon}</Box> : undefined}
      label={label}
      sx={{
        backgroundColor: emphasis ? t.primaryContainer : t.surfaceContainerHighest,
        color: emphasis ? t.onPrimaryContainer : t.onSurfaceVariant,
        border: `1px solid ${emphasis ? 'transparent' : t.outlineVariant}`,
        '& .MuiChip-icon': { color: 'inherit', mr: -0.25 }
      }}
    />
  )
}

export function DeviceCard({ device, onManageApps }: { device: DeviceInfo; onManageApps?: () => void }) {
  const t = useTokens()
  const ready = device.state === 'device'
  const tone = STATE_TONE[device.state]

  return (
    <Box
      component={motion.div}
      layout
      initial={{ opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      sx={{
        borderRadius: '16px',
        border: `1px solid ${ready ? t.outlineVariant : tone === 'error' ? `${t.error}66` : `${t.warning}66`}`,
        backgroundColor: t.surfaceContainerLow,
        p: 2.25,
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      {/* 左侧设备图标 */}
      <Box
        sx={{
          width: 52,
          height: 52,
          borderRadius: '16px',
          flex: '0 0 auto',
          display: 'grid',
          placeItems: 'center',
          backgroundColor: ready ? t.primaryContainer : t.surfaceContainerHighest,
          color: ready ? t.onPrimaryContainer : t.onSurfaceVariant,
          transition: 'background-color 260ms cubic-bezier(0.2,0,0,1)'
        }}
      >
        <PhoneAndroidRoundedIcon sx={{ fontSize: 27 }} />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: 16,
              fontWeight: 650,
              color: t.onSurface,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {device.model || (device.serialMissing ? '未知设备' : device.serial)}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1,
              height: 24,
              borderRadius: 100,
              flex: '0 0 auto',
              backgroundColor: ready ? `${t.success}1F` : `${t.warning}1F`
            }}
          >
            <StatusDot tone={tone} size={6} pulse={tone === 'busy' || tone === 'ok'} />
            <Typography
              sx={{
                fontSize: 11.5,
                fontWeight: 650,
                color: ready ? t.success : t.warning,
                whiteSpace: 'nowrap'
              }}
            >
              {STATE_TEXT[device.state]}
            </Typography>
          </Box>

          {ready && onManageApps && (
            <Tooltip title="查看设备上已安装的应用">
              <Button
                size="small"
                variant="contained"
                onClick={onManageApps}
                startIcon={<AppsRoundedIcon sx={{ fontSize: 16 }} />}
                sx={{
                  flex: '0 0 auto',
                  minHeight: 28,
                  px: 1.5,
                  fontSize: 12,
                  backgroundColor: t.surfaceContainerHighest,
                  color: t.onSurface,
                  '&:hover': { backgroundColor: t.surfaceContainerHigh }
                }}
              >
                管理应用
              </Button>
            </Tooltip>
          )}
        </Stack>

        <Typography sx={{ fontSize: 13, color: t.onSurfaceVariant, mt: 0.25 }}>
          {device.enriched ? (
            <>
              Android {device.androidRelease ?? '?'}
              {device.sdkInt != null && ` (API ${device.sdkInt})`}
              {device.manufacturer ? ` · ${device.manufacturer}` : ''}
            </>
          ) : (
            <Skeleton variant="text" width={168} sx={{ fontSize: 13 }} />
          )}
        </Typography>

        <AnimatePresence mode="wait">
          {device.enriched ? (
            <Box
              component={motion.div}
              key="meta"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            >
              <Stack direction="row" spacing={0.75} sx={{ mt: 1.25, flexWrap: 'wrap', gap: 0.75 }}>
                <MetaChip icon={<MemoryRoundedIcon sx={{ fontSize: 14 }} />} label={bitnessLabel(device)} emphasis />
                {device.abiList.length > 0 && <MetaChip label={device.abiList.join(' · ')} />}
                {device.storageFreeBytes != null && (
                  <MetaChip
                    icon={<StorageRoundedIcon sx={{ fontSize: 14 }} />}
                    label={`剩余 ${formatBytes(device.storageFreeBytes)}`}
                  />
                )}
                {device.isEmulator && <MetaChip label="模拟器" />}
              </Stack>
            </Box>
          ) : (
            <Stack direction="row" spacing={0.75} sx={{ mt: 1.25 }}>
              <Skeleton variant="rounded" width={92} height={22} />
              <Skeleton variant="rounded" width={128} height={22} />
            </Stack>
          )}
        </AnimatePresence>

        {!ready && (
          <Typography sx={{ fontSize: 12, color: t.warning, mt: 1, lineHeight: 1.55 }}>
            {device.state === 'unauthorized'
              ? '请在设备屏幕上点击「允许 USB 调试」，建议勾选「一律允许」。'
              : device.state === 'offline'
                ? '设备连接异常，可点击右侧「修复连接」重新握手。'
                : '设备当前状态无法安装应用。'}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export function DeviceEmpty({ onRepair, busy }: { onRepair: () => void; busy: boolean }) {
  const t = useTokens()
  return (
    <Box
      component={motion.div}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 360, damping: 32 }}
      sx={{
        borderRadius: '16px',
        border: `1.5px dashed ${t.outlineVariant}`,
        backgroundColor: t.surfaceContainerLow,
        p: 2.5,
        display: 'flex',
        alignItems: 'center',
        gap: 2
      }}
    >
      <Box
        sx={{
          width: 52,
          height: 52,
          borderRadius: '16px',
          display: 'grid',
          placeItems: 'center',
          backgroundColor: t.surfaceContainerHighest,
          color: t.onSurfaceVariant,
          flex: '0 0 auto'
        }}
      >
        <UsbRoundedIcon sx={{ fontSize: 26 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 15.5, fontWeight: 650, color: t.onSurface }}>
          未检测到 Android 设备
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: t.onSurfaceVariant, mt: 0.5, lineHeight: 1.6 }}>
          用 USB 数据线连接设备，并在「开发者选项」中开启 <b>USB 调试</b>。插上后会自动识别。
        </Typography>
      </Box>
      <Tooltip title="重置 ADB 服务并重新扫描设备">
        <Button
          variant="contained"
          size="small"
          onClick={onRepair}
          disabled={busy}
          startIcon={
            <RefreshRoundedIcon
              sx={{
                fontSize: 17,
                animation: busy ? 'apki-spin 1s linear infinite' : 'none'
              }}
            />
          }
          sx={{
            flex: '0 0 auto',
            backgroundColor: t.surfaceContainerHighest,
            color: t.onSurface,
            '&:hover': { backgroundColor: t.surfaceContainerHigh }
          }}
        >
          修复连接
        </Button>
      </Tooltip>
    </Box>
  )
}
