import { createContext, createElement, useContext, type ReactNode } from 'react'
import { createTheme, type Theme } from '@mui/material/styles'
import { buildPalette } from '@shared/md3'

export type Mode = 'light' | 'dark'

/**
 * 界面用到的全部色调令牌。
 * success / warning / info 是**语义色**，不参与动态取色 —— 无论壁纸什么颜色，
 * 「成功」都必须是绿的，否则会误导用户。
 */
export interface Tokens {
  primary: string
  onPrimary: string
  primaryContainer: string
  onPrimaryContainer: string
  surface: string
  surfaceContainerLowest: string
  surfaceContainerLow: string
  surfaceContainer: string
  surfaceContainerHigh: string
  surfaceContainerHighest: string
  onSurface: string
  onSurfaceVariant: string
  outline: string
  outlineVariant: string
  error: string
  errorContainer: string
  onErrorContainer: string
  success: string
  successContainer: string
  onSuccessContainer: string
  warning: string
  warningContainer: string
  onWarningContainer: string
  info: string
  infoContainer: string
  onInfoContainer: string
  shadow: string
}

/** 默认（未取色）浅色板 —— Material 3 基线紫 */
export const LIGHT: Tokens = {
  primary: '#6750A4',
  onPrimary: '#FFFFFF',
  primaryContainer: '#EADDFF',
  onPrimaryContainer: '#21005D',
  surface: '#FEF7FF',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F7F2FA',
  surfaceContainer: '#F3EDF7',
  surfaceContainerHigh: '#ECE6F0',
  surfaceContainerHighest: '#E6E0E9',
  onSurface: '#1D1B20',
  onSurfaceVariant: '#49454F',
  outline: '#79747E',
  outlineVariant: '#CAC4D0',
  error: '#B3261E',
  errorContainer: '#F9DEDC',
  onErrorContainer: '#410E0B',
  success: '#146C2E',
  successContainer: '#C4EED0',
  onSuccessContainer: '#05210D',
  warning: '#7A5900',
  warningContainer: '#FFDF9E',
  onWarningContainer: '#261A00',
  info: '#0B57D0',
  infoContainer: '#D6E3FF',
  onInfoContainer: '#001A41',
  shadow: 'rgba(0, 0, 0, 0.10)'
}

/** 默认深色板 */
export const DARK: Tokens = {
  primary: '#D0BCFF',
  onPrimary: '#381E72',
  primaryContainer: '#4F378B',
  onPrimaryContainer: '#EADDFF',
  surface: '#141218',
  surfaceContainerLowest: '#0F0D13',
  surfaceContainerLow: '#1D1B20',
  surfaceContainer: '#211F26',
  surfaceContainerHigh: '#2B2930',
  surfaceContainerHighest: '#36343B',
  onSurface: '#E6E1E5',
  onSurfaceVariant: '#CAC4D0',
  outline: '#938F99',
  outlineVariant: '#49454F',
  error: '#F2B8B5',
  errorContainer: '#8C1D18',
  onErrorContainer: '#F9DEDC',
  success: '#7ADB92',
  successContainer: '#0A5222',
  onSuccessContainer: '#C4EED0',
  warning: '#F0C048',
  warningContainer: '#5C4200',
  onWarningContainer: '#FFDF9E',
  info: '#A8C7FA',
  infoContainer: '#0842A0',
  onInfoContainer: '#D6E3FF',
  shadow: 'rgba(0, 0, 0, 0.45)'
}

/** 默认紫色种子（与 LIGHT.primary 对应） */
export const DEFAULT_SEED = '#6750A4'

/**
 * 生成某一模式下的令牌表。
 * seed 为空或解析失败时退回默认紫色板。
 */
export function tokensFor(mode: Mode, seed: string | null | undefined): Tokens {
  const base = mode === 'dark' ? DARK : LIGHT
  if (!seed) return base

  try {
    const palette = buildPalette(seed)
    const roles = mode === 'dark' ? palette.dark : palette.light
    return {
      ...base,
      // 用动态角色覆盖主色/表面/描边等，语义色保持固定
      primary: roles.primary,
      onPrimary: roles.onPrimary,
      primaryContainer: roles.primaryContainer,
      onPrimaryContainer: roles.onPrimaryContainer,
      surface: roles.surface,
      surfaceContainerLowest: roles.surfaceContainerLowest,
      surfaceContainerLow: roles.surfaceContainerLow,
      surfaceContainer: roles.surfaceContainer,
      surfaceContainerHigh: roles.surfaceContainerHigh,
      surfaceContainerHighest: roles.surfaceContainerHighest,
      onSurface: roles.onSurface,
      onSurfaceVariant: roles.onSurfaceVariant,
      outline: roles.outline,
      outlineVariant: roles.outlineVariant,
      error: roles.error,
      errorContainer: roles.errorContainer,
      onErrorContainer: roles.onErrorContainer
    }
  } catch {
    return base
  }
}

/* ------------------------------------------------------------------ */
/* 令牌上下文                                                          */
/* ------------------------------------------------------------------ */

const TokensContext = createContext<Tokens>(LIGHT)

export function TokensProvider({ tokens, children }: { tokens: Tokens; children: ReactNode }) {
  return createElement(TokensContext.Provider, { value: tokens }, children)
}

export function useTokens(): Tokens {
  return useContext(TokensContext)
}

/* ------------------------------------------------------------------ */
/* MUI 主题                                                            */
/* ------------------------------------------------------------------ */

const FONT_STACK = [
  '"Segoe UI Variable Text"',
  '"Segoe UI"',
  'system-ui',
  '-apple-system',
  '"PingFang SC"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  'Roboto',
  'sans-serif'
].join(', ')

export function getTheme(mode: Mode, t: Tokens): Theme {
  return createTheme({
    palette: {
      mode,
      primary: { main: t.primary, contrastText: t.onPrimary },
      secondary: { main: t.primary },
      error: { main: t.error, contrastText: mode === 'dark' ? '#601410' : '#FFFFFF' },
      success: { main: t.success },
      warning: { main: t.warning },
      info: { main: t.info },
      background: {
        default: t.surface,
        paper: t.surfaceContainerLow
      },
      text: {
        primary: t.onSurface,
        secondary: t.onSurfaceVariant
      },
      divider: t.outlineVariant
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: FONT_STACK,
      h5: { fontWeight: 600, letterSpacing: '-0.01em' },
      h6: { fontWeight: 600, letterSpacing: '-0.005em' },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { fontWeight: 600, textTransform: 'none', letterSpacing: 0 },
      body2: { lineHeight: 1.6 },
      caption: { lineHeight: 1.5 }
    },
    transitions: {
      easing: {
        easeOut: 'cubic-bezier(0.2, 0, 0, 1)',
        easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
        sharp: 'cubic-bezier(0.4, 0, 0.6, 1)'
      },
      duration: {
        shortest: 120,
        shorter: 160,
        short: 200,
        standard: 260,
        complex: 340,
        enteringScreen: 240,
        leavingScreen: 180
      }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: t.surface, color: t.onSurface }
        }
      },
      MuiStack: {
        // 用 CSS gap 取代 MUI 默认的「子元素负外边距」实现。
        // 负外边距会让容器 scrollWidth 超出 clientWidth（实测 865 > 860），
        // 在需要 flexWrap 的标签行上尤其明显。
        defaultProps: { useFlexGap: true }
      },
      MuiButton: {
        defaultProps: { disableElevation: true, disableRipple: false },
        styleOverrides: {
          root: {
            borderRadius: '100px',
            paddingInline: 20,
            minHeight: 40,
            transition:
              'background-color 200ms cubic-bezier(0.2,0,0,1), box-shadow 200ms cubic-bezier(0.2,0,0,1), transform 160ms cubic-bezier(0.2,0,0,1)',
            '&:active': { transform: 'scale(0.97)' }
          },
          sizeLarge: { minHeight: 48, fontSize: 16, paddingInline: 28 },
          sizeSmall: { minHeight: 32, paddingInline: 14 }
        }
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            transition: 'background-color 180ms cubic-bezier(0.2,0,0,1), transform 160ms cubic-bezier(0.2,0,0,1)',
            '&:active': { transform: 'scale(0.92)' }
          }
        }
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: 'none' },
          rounded: { borderRadius: '16px' }
        }
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderRadius: '16px',
            border: `1px solid ${t.outlineVariant}`,
            backgroundColor: t.surfaceContainerLow,
            backgroundImage: 'none'
          }
        }
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: '8px', fontWeight: 600, height: 26 },
          label: { paddingInline: 10, fontSize: 12 },
          sizeSmall: { height: 22 }
        }
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: '100px', height: 6, backgroundColor: t.surfaceContainerHighest },
          bar: { borderRadius: '100px' }
        }
      },
      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 400 },
        styleOverrides: {
          tooltip: {
            borderRadius: '8px',
            fontSize: 12,
            paddingInline: 10,
            paddingBlock: 6,
            fontWeight: 500,
            backgroundColor: mode === 'dark' ? '#E6E1E5' : '#322F35',
            color: mode === 'dark' ? '#1D1B20' : '#F5EFF7'
          },
          arrow: { color: mode === 'dark' ? '#E6E1E5' : '#322F35' }
        }
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: '20px',
            border: `1px solid ${t.outlineVariant}`,
            backgroundColor: t.surfaceContainerHigh
          }
        }
      },
      MuiDialogTitle: {
        styleOverrides: { root: { fontSize: 20, fontWeight: 600, paddingBottom: 8 } }
      },
      MuiSwitch: {
        styleOverrides: {
          // 不要改 root 的 padding —— Switch 内部是绝对定位的固定尺寸，
          // 加 padding 会让内容溢出容器（实测 scrollWidth 96 > clientWidth 58）
          track: { borderRadius: 100 }
        }
      },
      MuiSnackbarContent: {
        styleOverrides: { root: { borderRadius: '12px' } }
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: '12px', alignItems: 'center' },
          message: { fontSize: 13, fontWeight: 500, padding: 0 }
        }
      },
      MuiListItemButton: {
        styleOverrides: { root: { borderRadius: '10px' } }
      },
      MuiDivider: {
        styleOverrides: { root: { borderColor: t.outlineVariant } }
      },
      MuiSkeleton: {
        styleOverrides: { root: { borderRadius: '8px' } }
      }
    }
  })
}
