import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { Box, Button, Stack, Typography } from '@mui/material'
import { motion } from 'framer-motion'
import { useTokens } from '../theme'

interface Props {
  onPick: () => void
  /** 有文件正悬停在窗口上方 */
  dragging: boolean
  disabled?: boolean
}

export function DropZone({ onPick, dragging, disabled }: Props) {
  const t = useTokens()

  return (
    <Box
      component={motion.div}
      layout
      onClick={disabled ? undefined : onPick}
      animate={{
        scale: dragging ? 1.012 : 1,
        borderColor: dragging ? t.primary : t.outlineVariant,
        backgroundColor: dragging ? `${t.primary}0F` : t.surfaceContainerLow
      }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      sx={{
        borderRadius: '16px',
        borderWidth: 1.5,
        borderStyle: 'dashed',
        minHeight: 208,
        display: 'grid',
        placeItems: 'center',
        cursor: disabled ? 'default' : 'pointer',
        position: 'relative',
        overflow: 'hidden',
        opacity: disabled ? 0.55 : 1,
        '&:hover': disabled
          ? undefined
          : {
              borderColor: t.primary,
              backgroundColor: `${t.primary}08`
            }
      }}
    >
      {/* 背景光晕：拖拽时浮现，增强“可以放这里”的暗示 */}
      <Box
        component={motion.div}
        animate={{ opacity: dragging ? 1 : 0, scale: dragging ? 1 : 0.7 }}
        transition={{ duration: 0.34, ease: [0.2, 0, 0, 1] }}
        sx={{
          position: 'absolute',
          width: 340,
          height: 340,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${t.primary}26 0%, transparent 68%)`,
          pointerEvents: 'none'
        }}
      />

      <Stack spacing={1.75} sx={{ alignItems: 'center', position: 'relative', py: 4, px: 3 }}>
        <Box
          component={motion.div}
          animate={{ y: dragging ? -7 : [0, -5, 0] }}
          transition={
            dragging
              ? { type: 'spring', stiffness: 420, damping: 22 }
              : { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }
          }
          sx={{
            width: 68,
            height: 68,
            borderRadius: '18px',
            display: 'grid',
            placeItems: 'center',
            backgroundColor: dragging ? t.primaryContainer : t.surfaceContainerHighest,
            color: dragging ? t.onPrimaryContainer : t.onSurfaceVariant,
            transition: 'background-color 240ms cubic-bezier(0.2,0,0,1)'
          }}
        >
          <Inventory2RoundedIcon sx={{ fontSize: 33 }} />
        </Box>

        <Box sx={{ textAlign: 'center' }}>
          <Typography sx={{ fontSize: 17, fontWeight: 650, color: t.onSurface, letterSpacing: '-0.01em' }}>
            {dragging ? '松开即可载入安装包' : '拖入 APK 安装包'}
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: t.onSurfaceVariant, mt: 0.5 }}>
            也可以点击此处从文件管理器选择，支持同时拖入多个
          </Typography>
        </Box>

        <Button
          variant="contained"
          size="small"
          disabled={disabled}
          startIcon={<FolderOpenRoundedIcon sx={{ fontSize: 17 }} />}
          onClick={(e) => {
            e.stopPropagation()
            onPick()
          }}
          sx={{ backgroundColor: t.primary, color: t.onPrimary, '&:hover': { backgroundColor: t.primary } }}
        >
          选择安装包
        </Button>
      </Stack>
    </Box>
  )
}
