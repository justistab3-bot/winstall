import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import type { AppSettings, DeviceInfo, DynamicColorState } from '@shared/types'
import { useTokens } from '../theme'

interface Props {
  open: boolean
  settings: AppSettings | null
  device: DeviceInfo | null
  color: DynamicColorState | null
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTokens()
  return (
    <Typography
      sx={{
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: t.primary,
        mb: 0.5
      }}
    >
      {children}
    </Typography>
  )
}

function Row({
  title,
  desc,
  control,
  disabled
}: {
  title: string
  desc: string
  control: React.ReactNode
  disabled?: boolean
}) {
  const t = useTokens()
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{ alignItems: 'center', py: 1.25, opacity: disabled ? 0.5 : 1 }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: t.onSurface }}>{title}</Typography>
        <Typography sx={{ fontSize: 12, color: t.onSurfaceVariant, mt: 0.25, lineHeight: 1.55 }}>{desc}</Typography>
      </Box>
      {control}
    </Stack>
  )
}

export function SettingsDialog({ open, settings, device, color, onChange, onClose }: Props) {
  const t = useTokens()
  if (!settings) return null

  const supportsGrant = device?.sdkInt == null || device.sdkInt >= 23

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <Stack direction="row" sx={{ alignItems: 'center', px: 3, pt: 2.5, pb: 1 }}>
        <Typography sx={{ fontSize: 19, fontWeight: 650, color: t.onSurface, flex: 1 }}>设置</Typography>
        <IconButton size="small" onClick={onClose} sx={{ color: t.onSurfaceVariant }}>
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>

      <DialogContent sx={{ px: 3, pb: 3 }}>
        <SectionTitle>外观</SectionTitle>
        <Row
          title="主题"
          desc="跟随系统时会随 Windows 的浅色/深色设置自动切换。"
          control={
            <ToggleButtonGroup
              exclusive
              size="small"
              value={settings.theme}
              onChange={(_e, v) => v && onChange({ theme: v })}
              sx={{
                '& .MuiToggleButton-root': {
                  px: 1.5,
                  py: 0.5,
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: 'none',
                  borderRadius: '100px !important',
                  borderColor: t.outlineVariant
                }
              }}
            >
              <ToggleButton value="system">跟随系统</ToggleButton>
              <ToggleButton value="light">浅色</ToggleButton>
              <ToggleButton value="dark">深色</ToggleButton>
            </ToggleButtonGroup>
          }
        />

        <Row
          title="壁纸动态取色"
          desc={
            color?.seed
              ? `已从壁纸提取种子色 ${color.seed}，界面配色会跟随壁纸变化。${color.error ? `（${color.error}）` : ''}`
              : color?.enabled
                ? (color.error ?? '正在从壁纸提取颜色…')
                : '开启后会读取 Windows 壁纸的主色调，生成整套 Material You 配色。'
          }
          control={
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              {color?.seed && (
                <Box
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '7px',
                    backgroundColor: color.seed,
                    border: `1px solid ${t.outlineVariant}`,
                    flex: '0 0 auto'
                  }}
                />
              )}
              <Switch
                checked={settings.dynamicColor}
                onChange={(e) => onChange({ dynamicColor: e.target.checked })}
              />
            </Stack>
          }
        />

        <Divider sx={{ my: 1.5 }} />
        <SectionTitle>安装选项</SectionTitle>

        <Row
          title="批量安装"
          desc="一次拖入多个安装包时，装完一个自动继续下一个。中途失败会停下来并说明原因。"
          control={
            <Switch checked={settings.batchInstall} onChange={(e) => onChange({ batchInstall: e.target.checked })} />
          }
        />

        <Row
          title="覆盖安装"
          desc="对应 adb install -r。已安装同包名应用时直接替换，保留数据。"
          control={
            <Switch checked={settings.replace} onChange={(e) => onChange({ replace: e.target.checked })} />
          }
        />

        <Row
          title="安装时授予全部权限"
          desc={
            supportsGrant
              ? '对应 -g。安装完成后自动同意运行时权限，省去在设备上逐项点击。'
              : '当前设备为 Android 6.0 以下，系统不支持该参数，已自动跳过。'
          }
          disabled={!supportsGrant}
          control={
            <Switch
              checked={settings.grantAll && supportsGrant}
              disabled={!supportsGrant}
              onChange={(e) => onChange({ grantAll: e.target.checked })}
            />
          }
        />

        <Row
          title="允许版本降级"
          desc="对应 -d。设备上已装更高版本时仍强制安装当前包，可能丢失数据。"
          control={
            <Switch
              checked={settings.allowDowngrade}
              onChange={(e) => onChange({ allowDowngrade: e.target.checked })}
            />
          }
        />

        <Row
          title="允许测试包"
          desc="对应 -t。安装标记为 testOnly 的调试包。"
          control={
            <Switch checked={settings.allowTest} onChange={(e) => onChange({ allowTest: e.target.checked })} />
          }
        />

        <Row
          title="安装后自动启动"
          desc="安装成功后自动拉起应用主界面。"
          control={
            <Switch
              checked={settings.launchAfterInstall}
              onChange={(e) => onChange({ launchAfterInstall: e.target.checked })}
            />
          }
        />

        <Divider sx={{ my: 1.5 }} />
        <SectionTitle>ADB</SectionTitle>

        <Box sx={{ py: 1.25 }}>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: t.onSurface }}>自定义 adb 路径</Typography>
          <Typography sx={{ fontSize: 12, color: t.onSurfaceVariant, mt: 0.25, lineHeight: 1.55, mb: 1 }}>
            留空则自动查找。程序会按「内置 platform-tools → Android SDK → 系统 PATH」的顺序探测，并自动处理端口与版本冲突。
          </Typography>
          <Stack direction="row" spacing={1}>
            <Box
              component="input"
              value={settings.adbPathOverride}
              placeholder="例如 D:\\Android\\platform-tools\\adb.exe"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ adbPathOverride: e.target.value })}
              spellCheck={false}
              sx={{
                flex: 1,
                height: 40,
                px: 1.5,
                borderRadius: '10px',
                fontSize: 12.5,
                fontFamily: 'Consolas, "Cascadia Mono", monospace',
                color: t.onSurface,
                backgroundColor: t.surfaceContainerHighest,
                border: `1px solid ${t.outlineVariant}`,
                outline: 'none',
                '&:focus': { borderColor: t.primary },
                '&::placeholder': { color: `${t.onSurfaceVariant}99` }
              }}
            />
            <Tooltip title="恢复自动探测">
              <Button
                variant="text"
                onClick={() => onChange({ adbPathOverride: '' })}
                sx={{ color: t.onSurfaceVariant, minWidth: 64 }}
              >
                自动
              </Button>
            </Tooltip>
          </Stack>
        </Box>

        <Divider sx={{ my: 1.5 }} />
        <Typography sx={{ fontSize: 11.5, color: t.onSurfaceVariant, lineHeight: 1.7 }}>
          Winstall v1.1.0 · 纯本地运行，不联网、不上传任何数据。
          <br />
          解析 APK 与安装均在本机完成，安装结束后会自动清理设备上的临时文件。
        </Typography>
      </DialogContent>
    </Dialog>
  )
}
