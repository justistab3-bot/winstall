/**
 * 可靠地启动 Electron 二进制。
 *
 * 为什么不直接用 `electron` CLI：npm 包自带的 cli.js 依赖 `#!/usr/bin/env node`
 * 的解析结果，在装有多个 Node 的环境里可能被解析到别的运行时，
 * 导致实际跑起来的是 Node 而不是 Electron（表现为 `--version` 打印 Node 版本）。
 *
 * `require('electron')` 返回的是二进制绝对路径，直接 spawn 它最稳。
 *
 *   node scripts/run-electron.cjs scripts/ui-verify.cjs
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const electronPath = require('electron')

if (typeof electronPath !== 'string') {
  console.error('无法解析 Electron 二进制路径，请确认已执行 npm install 且 Electron 已下载完成。')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node scripts/run-electron.cjs <script.cjs> [args...]')
  process.exit(1)
}

/**
 * 必须清掉 ELECTRON_RUN_AS_NODE。
 * 只要它存在，electron.exe 会退化成普通 Node 运行 —— 表现是
 * `--version` 打印 Node 的版本、`require('electron')` 拿不到 app/BrowserWindow。
 * 某些宿主环境（例如把 Electron 当运行时用的 IDE/工具）会注入这个变量。
 */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(electronPath, args, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env,
  windowsHide: false
})

if (result.error) {
  console.error('启动 Electron 失败：', result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
