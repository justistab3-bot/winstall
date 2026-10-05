import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import InfoRoundedIcon from '@mui/icons-material/InfoRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Box, Collapse, Stack, Typography } from '@mui/material'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import type { CompatIssue, CompatLevel, CompatReport } from '@shared/types'
import { useTokens, type Tokens } from '../theme'

const LEVEL_ICON = {
  ok: CheckCircleRoundedIcon,
  info: InfoRoundedIcon,
  warning: WarningAmberRoundedIcon,
  error: ErrorRoundedIcon
} as const

function levelColors(level: CompatLevel, t: Tokens): { fg: string; bg: string } {
  switch (level) {
    case 'ok':
      return { fg: t.success, bg: `${t.success}17` }
    case 'warning':
      return { fg: t.warning, bg: `${t.warning}17` }
    case 'error':
      return { fg: t.error, bg: `${t.error}17` }
    default:
      return { fg: t.info, bg: `${t.info}17` }
  }
}

function IssueRow({ issue }: { issue: CompatIssue }) {
  const t = useTokens()
  const { fg } = levelColors(issue.level, t)
  const Icon = LEVEL_ICON[issue.level]

  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'flex-start' }}>
      <Icon sx={{ fontSize: 17, color: fg, mt: 0.15, flex: '0 0 auto' }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 650, color: t.onSurface, lineHeight: 1.5 }}>
          {issue.title}
        </Typography>
        {issue.detail && (
          <Typography
            className="selectable"
            sx={{ fontSize: 12.5, color: t.onSurfaceVariant, lineHeight: 1.65, mt: 0.25 }}
          >
            {issue.detail}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}

export function CompatBanner({ report }: { report: CompatReport }) {
  const t = useTokens()
  const [expanded, setExpanded] = useState(false)

  const { fg, bg } = levelColors(report.level, t)
  const Icon = LEVEL_ICON[report.level]

  // 结论永远显示；细节默认展开前 2 条，其余折叠，保持界面简洁
  const visible = expanded ? report.issues : report.issues.slice(0, 2)
  const hiddenCount = report.issues.length - visible.length

  return (
    <Box
      component={motion.div}
      layout
      sx={{
        borderRadius: '12px',
        backgroundColor: bg,
        border: `1px solid ${fg}33`,
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        spacing={1.25}
        sx={{ alignItems: 'center', px: 1.75, py: 1.25 }}
        onClick={() => hiddenCount !== 0 && setExpanded((v) => !v)}
        role={hiddenCount !== 0 ? 'button' : undefined}
        style={{ cursor: hiddenCount !== 0 ? 'pointer' : 'default' }}
      >
        <Icon sx={{ fontSize: 19, color: fg, flex: '0 0 auto' }} />
        <Typography sx={{ fontSize: 13.5, fontWeight: 700, color: fg, flex: 1, lineHeight: 1.4 }}>
          {report.headline}
        </Typography>
        {hiddenCount !== 0 && (
          <Box
            component={motion.div}
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            sx={{ display: 'flex', color: fg, opacity: 0.8 }}
          >
            <ExpandMoreRoundedIcon sx={{ fontSize: 19 }} />
          </Box>
        )}
      </Stack>

      <Collapse in={expanded || report.issues.length > 0} timeout={220}>
        <Stack spacing={1.5} sx={{ px: 1.75, pb: 1.75, pt: 0.25 }}>
          <AnimatePresence initial={false}>
            {visible.map((issue) => (
              <Box
                component={motion.div}
                key={issue.code + issue.title}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                sx={{ overflow: 'hidden' }}
              >
                <IssueRow issue={issue} />
              </Box>
            ))}
          </AnimatePresence>
          {hiddenCount > 0 && (
            <Typography
              onClick={() => setExpanded(true)}
              sx={{ fontSize: 12, fontWeight: 650, color: fg, cursor: 'pointer', pl: 3.75 }}
            >
              展开另外 {hiddenCount} 条
            </Typography>
          )}
        </Stack>
      </Collapse>
    </Box>
  )
}
