import AndroidRoundedIcon from '@mui/icons-material/AndroidRounded'
import BlockRoundedIcon from '@mui/icons-material/BlockRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded'
import RocketLaunchRoundedIcon from '@mui/icons-material/RocketLaunchRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { AnimatePresence, motion } from 'framer-motion'
import type { ApkInfo, CompatReport, DeviceInfo, InstallProgress } from '@shared/types'
import { useTokens } from '../theme'
import { formatBytes } from '../format'
import { CompatBanner } from './CompatBanner'

interface Props {
  apk: ApkInfo
  report: CompatReport
  device: DeviceInfo | null
  progress: InstallProgress | null
  /** 当前这个包已经安装成功 */
  installed: boolean
  /** 批量安装进度 */
  batch: { running: boolean; index: number; total: number }
  onInstall: () => void
  onOpenApp: () => void
  onCancel: () => void
  onClear: () => void
  onPick: () => void
}

function AppIcon({ apk }: { apk: ApkInfo }) {
  const t = useTokens()
  const letter = (apk.appLabel || apk.packageName || apk.fileName || '?').trim().charAt(0).toUpperCase()

  if (apk.iconDataUrl) {
    return (
      <Box
        component="img"
        src={apk.iconDataUrl}
        alt=""
        sx={{
          width: 56,
          height: 56,
          borderRadius: '16px',
          flex: '0 0 auto',
          objectFit: 'contain',
          backgroundColor: t.surfaceContainerHighest,
          p: 0.25
        }}
      />
    )
  }

  return (
    <Box
      sx={{
        width: 56,
        height: 56,
        borderRadius: '16px',
        flex: '0 0 auto',
        display: 'grid',
        placeItems: 'center',
        background: `linear-gradient(135deg, ${t.primaryContainer}, ${t.surfaceContainerHighest})`,
        color: t.onPrimaryContainer,
        fontSize: 24,
        fontWeight: 700
      }}
    >
      {letter || <AndroidRoundedIcon />}
    </Box>
  )
}

function StageRow({ progress }: { progress: InstallProgress }) {
  const t = useTokens()
  const stages: Array<{ key: string; label: string }> = [
    { key: 'pushing', label: '推送' },
    { key: 'installing', label: '安装' },
    { key: 'success', label: '完成' }
  ]

  const currentIndex =
    progress.stage === 'preparing'
      ? 0
      : progress.stage === 'pushing'
        ? 0
        : progress.stage === 'installing'
          ? 1
          : progress.stage === 'cleaning'
            ? 2
            : progress.stage === 'success'
              ? 2
              : 0

  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      {stages.map((s, i) => {
        const done = i < currentIndex || progress.stage === 'success'
        const active = i === currentIndex && progress.stage !== 'success'
        return (
          <Box key={s.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box
              component={motion.div}
              animate={{
                backgroundColor: done ? t.primary : active ? t.primary : t.surfaceContainerHighest,
                color: done || active ? t.onPrimary : t.onSurfaceVariant,
                scale: active ? 1.04 : 1
              }}
              transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
              sx={{
                px: 1.25,
                height: 22,
                borderRadius: 100,
                display: 'grid',
                placeItems: 'center',
                fontSize: 11.5,
                fontWeight: 650
              }}
            >
              {s.label}
            </Box>
            {i < stages.length - 1 && (
              <Box
                component={motion.div}
                animate={{ backgroundColor: i < currentIndex ? t.primary : t.outlineVariant }}
                sx={{ width: 16, height: 2, borderRadius: '2px' }}
              />
            )}
          </Box>
        )
      })}
    </Stack>
  )
}

export function ApkCard({
  apk,
  report,
  device,
  progress,
  installed,
  batch,
  onInstall,
  onOpenApp,
  onCancel,
  onClear,
  onPick
}: Props) {
  const t = useTokens()
  const installing = !!progress && progress.stage !== 'success' && progress.stage !== 'failed'
  const busy = !!progress

  const chips: Array<{ label: string; tone?: 'primary' | 'plain' }> = []
  if (apk.versionName) chips.push({ label: `v${apk.versionName}` })
  if (apk.minSdk != null) chips.push({ label: `minSdk ${apk.minSdk}` })
  if (apk.targetSdk != null) chips.push({ label: `targetSdk ${apk.targetSdk}` })
  if (apk.nativeAbis.length > 0) chips.push({ label: apk.nativeAbis.join(' / ') })
  else chips.push({ label: '无 native 库' })
  if (apk.debuggable) chips.push({ label: '可调试' })

  return (
    <Box
      component={motion.div}
      layout
      initial={{ opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      sx={{
        borderRadius: '16px',
        border: `1px solid ${t.outlineVariant}`,
        backgroundColor: t.surfaceContainerLow,
        p: 2.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.75
      }}
    >
      {/* 头部：图标 + 名称 + 元信息 */}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <AppIcon apk={apk} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
              {apk.appLabel || apk.packageName || apk.fileName}
            </Typography>
          </Stack>

          <Tooltip title={apk.filePath} placement="bottom-start">
            <Typography
              sx={{
                fontSize: 12.5,
                color: t.onSurfaceVariant,
                mt: 0.25,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {apk.packageName ?? '未知包名'}
              {apk.versionCode != null ? ` · 版本号 ${apk.versionCode}` : ''} · {formatBytes(apk.fileSize)}
            </Typography>
          </Tooltip>

          <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.75 }}>
            {chips.map((c) => (
              <Chip
                key={c.label}
                size="small"
                label={c.label}
                sx={{
                  backgroundColor: t.surfaceContainerHighest,
                  color: t.onSurfaceVariant,
                  border: `1px solid ${t.outlineVariant}`
                }}
              />
            ))}
          </Stack>
        </Box>

        <Stack direction="row" spacing={0.25} sx={{ flex: '0 0 auto' }}>
          <Tooltip title="换一个安装包">
            <span>
              <IconButton size="small" onClick={onPick} disabled={busy} sx={{ color: t.onSurfaceVariant }}>
                <FolderOpenRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="移除">
            <span>
              <IconButton size="small" onClick={onClear} disabled={busy} sx={{ color: t.onSurfaceVariant }}>
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {/* 安装中：进度区；空闲：兼容性结论 */}
      <AnimatePresence mode="wait" initial={false}>
        {installing ? (
          <Box
            component={motion.div}
            key="progress"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            sx={{
              borderRadius: '12px',
              backgroundColor: `${t.primary}12`,
              border: `1px solid ${t.primary}33`,
              p: 1.75
            }}
          >
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1.25 }}>
              <StageRow progress={progress} />
              {batch.running && batch.total > 1 && (
                <Chip
                  size="small"
                  label={`第 ${batch.index} / ${batch.total} 个`}
                  sx={{ backgroundColor: `${t.primary}1F`, color: t.primary, height: 22, fontSize: 11 }}
                />
              )}
              <Box sx={{ flex: 1 }} />
              <Typography sx={{ fontSize: 13, fontWeight: 700, color: t.primary, minWidth: 42, textAlign: 'right' }}>
                {progress.indeterminate ? '' : `${progress.percent}%`}
              </Typography>
            </Stack>

            <LinearProgress
              variant={progress.indeterminate ? 'indeterminate' : 'determinate'}
              value={progress.percent}
              sx={{
                backgroundColor: `${t.primary}22`,
                '& .MuiLinearProgress-bar': {
                  backgroundColor: t.primary,
                  transition: 'transform 260ms cubic-bezier(0.2,0,0,1)'
                }
              }}
            />

            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mt: 1.25 }}>
              <Typography sx={{ fontSize: 12.5, color: t.onSurfaceVariant, flex: 1 }}>
                {progress.message}
                {progress.bytesTotal && progress.bytesSent != null && progress.stage === 'pushing'
                  ? `　${formatBytes(progress.bytesSent)} / ${formatBytes(progress.bytesTotal)}`
                  : ''}
              </Typography>
              <Button
                size="small"
                variant="text"
                onClick={onCancel}
                startIcon={<StopRoundedIcon sx={{ fontSize: 16 }} />}
                sx={{ color: t.error, minHeight: 30 }}
              >
                取消
              </Button>
            </Stack>
          </Box>
        ) : (
          <Box
            component={motion.div}
            key="compat"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <CompatBanner report={report} />
          </Box>
        )}
      </AnimatePresence>

      {/* 底部操作 */}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {installed && !busy ? (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <CheckCircleRoundedIcon sx={{ fontSize: 16, color: t.success }} />
              <Typography
                sx={{
                  fontSize: 12,
                  color: t.onSurfaceVariant,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                已安装到 {device?.model || device?.id}
              </Typography>
            </Stack>
          ) : (
            report.installable &&
            !busy &&
            device?.state === 'device' && (
              <Typography
                sx={{
                  fontSize: 12,
                  color: t.onSurfaceVariant,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                将安装到 {device.model || device.id}
              </Typography>
            )
          )}
        </Box>

        {/* 安装成功后主操作变成「打开应用」 */}
        {installed && !busy && (
          <Button
            variant="text"
            size="large"
            onClick={onInstall}
            disabled={!report.installable || !device || device.state !== 'device'}
            sx={{ color: t.onSurfaceVariant, px: 2 }}
          >
            重新安装
          </Button>
        )}

        {installed && !busy ? (
          <Button
            variant="contained"
            size="large"
            onClick={onOpenApp}
            startIcon={<OpenInNewRoundedIcon sx={{ fontSize: 19 }} />}
            sx={{
              backgroundColor: t.primary,
              color: t.onPrimary,
              px: 3.5,
              '&:hover': { backgroundColor: t.primary }
            }}
          >
            打开应用
          </Button>
        ) : (
          <Button
            variant="contained"
            size="large"
            disabled={!report.installable || busy || !device || device.state !== 'device'}
            onClick={onInstall}
            startIcon={
              busy ? (
                <CircularProgress size={17} sx={{ color: 'inherit' }} />
              ) : report.installable ? (
                <RocketLaunchRoundedIcon sx={{ fontSize: 19 }} />
              ) : (
                <BlockRoundedIcon sx={{ fontSize: 19 }} />
              )
            }
            sx={{
              backgroundColor: report.installable ? t.primary : t.surfaceContainerHighest,
              color: report.installable ? t.onPrimary : t.onSurfaceVariant,
              px: 3.5,
              '&:hover': { backgroundColor: report.installable ? t.primary : t.surfaceContainerHighest },
              '&.Mui-disabled': {
                backgroundColor: t.surfaceContainerHighest,
                color: `${t.onSurfaceVariant}99`
              }
            }}
          >
            {busy ? '安装中…' : report.installable ? '开始安装' : '无法安装'}
          </Button>
        )}
      </Stack>
    </Box>
  )
}
