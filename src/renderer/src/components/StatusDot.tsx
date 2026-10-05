import { Box } from '@mui/material'
import { motion } from 'framer-motion'

export type DotTone = 'ok' | 'warn' | 'error' | 'idle' | 'busy'

const TONE_COLOR: Record<DotTone, string> = {
  ok: '#34C759',
  warn: '#FF9F0A',
  error: '#FF453A',
  idle: '#8E8E93',
  busy: '#0A84FF'
}

/**
 * 带呼吸光晕的状态圆点。
 * 光晕用独立的 span + CSS 动画实现，避免和 framer-motion 的 transform 打架。
 */
export function StatusDot({
  tone,
  size = 8,
  pulse = false
}: {
  tone: DotTone
  size?: number
  pulse?: boolean
}) {
  const color = TONE_COLOR[tone]
  return (
    <Box
      component="span"
      sx={{ position: 'relative', display: 'inline-flex', width: size, height: size, flex: '0 0 auto' }}
    >
      {pulse && (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            backgroundColor: color,
            animation: 'apki-pulse 1.8s cubic-bezier(0.2, 0, 0, 1) infinite'
          }}
        />
      )}
      <Box
        component={motion.span}
        animate={{ scale: [1, 1.12, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        sx={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 0 3px ${color}22`
        }}
      />
    </Box>
  )
}
