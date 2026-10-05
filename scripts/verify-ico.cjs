// 校验 build/icon.ico 的结构，确认 Windows 能正常读取
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '..', 'build', 'icon.ico')
const b = fs.readFileSync(file)

const reserved = b.readUInt16LE(0)
const type = b.readUInt16LE(2)
const count = b.readUInt16LE(4)
console.log(`ICO 头: reserved=${reserved} type=${type} count=${count}`)
if (reserved !== 0 || type !== 1) console.log('  ✗ 头部字段不合法')

let ok = true
const sizes = []
for (let i = 0; i < count; i++) {
  const p = 6 + i * 16
  const w = b.readUInt8(p) || 256
  const h = b.readUInt8(p + 1) || 256
  const bpp = b.readUInt16LE(p + 6)
  const size = b.readUInt32LE(p + 8)
  const off = b.readUInt32LE(p + 12)
  const sig = b.subarray(off, off + 8)
  const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47
  const inBounds = off + size <= b.length
  if (!isPng || !inBounds) ok = false
  sizes.push(w)
  console.log(
    `  ${String(w).padStart(3)}×${String(h).padEnd(3)} ${String(bpp).padStart(2)}bpp` +
      `  ${String(size).padStart(6)}B  @${String(off).padStart(6)}` +
      `  PNG=${isPng ? '✓' : '✗'}  越界=${inBounds ? '否' : '是'}`
  )
}

const expect = [16, 24, 32, 48, 64, 128, 256]
const missing = expect.filter((s) => !sizes.includes(s))
if (missing.length) {
  console.log(`  ✗ 缺少尺寸: ${missing.join(', ')}`)
  ok = false
}

console.log(`\n文件大小 ${b.length} B`)
console.log(ok ? 'ICO 结构正确 ✓' : 'ICO 结构有问题 ✗')
process.exit(ok ? 0 : 1)
