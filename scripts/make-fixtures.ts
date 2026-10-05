/**
 * 生成 UI 截图夹具：用真实 APK 解析结果（含图标 data URL）驱动界面渲染。
 *   npx tsx scripts/make-fixtures.ts
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseApk } from '../src/main/apk'

const SAMPLES = 'D:\\worker\\_apk_samples'
const OUT = path.join(process.cwd(), 'scripts', '.fixtures.json')

async function main(): Promise<void> {
  const files = [
    path.join(SAMPLES, 'com.topjohnwu.magisk.apk'),
    path.join(SAMPLES, 'com.keanbin.pinyinime.apk'),
    path.join(SAMPLES, 'com.pen.launcher.apk')
  ]

  const apks = []
  for (const f of files) {
    apks.push(await parseApk(f))
  }

  writeFileSync(OUT, JSON.stringify({ apks }, null, 2), 'utf8')
  console.log(`已写入 ${OUT}`)
  for (const a of apks) {
    console.log(
      `  ${a.fileName}  label=${a.appLabel}  icon=${a.iconDataUrl ? `${Math.round(a.iconDataUrl.length / 1024)}KB` : '无'}  abis=[${a.nativeAbis.join(',')}]`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
