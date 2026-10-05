/**
 * 把本机 Android SDK 里的 platform-tools 复制到 resources/ 下，
 * 让打包出来的程序自带 adb（目标机器无需安装 Android SDK）。
 *
 *   npm run fetch-platform-tools
 *
 * 没有本机 SDK 时，直接从官网下载并解压到 resources/platform-tools：
 *   https://developer.android.com/tools/releases/platform-tools
 *
 * 注意：这一步是可选的。缺少内置 adb 时，程序会自动回退到
 * Android SDK / 系统 PATH 里的 adb，功能不受影响。
 */
const { existsSync, mkdirSync, copyFileSync, statSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DEST = path.join(ROOT, 'resources', 'platform-tools')
const FILES = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']
const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'

function candidates() {
  const out = []
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[env]) out.push(path.join(process.env[env], 'platform-tools'))
  }
  const local = process.env.LOCALAPPDATA
  const home = process.env.USERPROFILE || process.env.HOME
  if (local) out.push(path.join(local, 'Android', 'Sdk', 'platform-tools'))
  if (home) {
    out.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools'))
    out.push(path.join(home, 'Android', 'Sdk', 'platform-tools'))
  }
  out.push('C:\\Android\\Sdk\\platform-tools', 'C:\\Android\\platform-tools')
  return out
}

const found = candidates().find((dir) => existsSync(path.join(dir, EXE)))

if (!found) {
  console.error('未在本机找到 Android SDK platform-tools。')
  console.error('请手动下载后解压到 resources/platform-tools：')
  console.error('  https://developer.android.com/tools/releases/platform-tools')
  console.error('（这一步是可选的，缺少内置 adb 时程序会回退到 SDK / PATH 里的 adb）')
  process.exit(1)
}

mkdirSync(DEST, { recursive: true })
let copied = 0
for (const name of FILES) {
  const src = path.join(found, name)
  if (!existsSync(src)) continue
  copyFileSync(src, path.join(DEST, name))
  copied++
  console.log(`  ${name}  ${(statSync(src).size / 1024 / 1024).toFixed(2)} MB`)
}

console.log(`\n已从 ${found} 复制 ${copied} 个文件到 resources/platform-tools/`)
