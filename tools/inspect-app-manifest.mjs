// 查桌面 App（asar 内的 dsh/package.json）如何声明 preset 定义来源。
import fs from 'node:fs'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
function cat(inner) {
  const fd = fs.openSync(ASAR, 'r')
  try {
    const h = Buffer.alloc(16)
    fs.readSync(fd, h, 0, 16, 0)
    const n = h.readUInt32LE(12)
    const j = Buffer.alloc(n)
    fs.readSync(fd, j, 0, n, 16)
    const ds = 16 + n + ((4 - ((16 + n) % 4)) % 4)
    const index = JSON.parse(j.toString('utf8'))
    let node = index
    for (const part of inner.split('/')) node = node.files?.[part]
    if (!node) throw new Error('缺 ' + inner)
    const b = Buffer.alloc(Number(node.size))
    fs.readSync(fd, b, 0, b.length, ds + Number(node.offset))
    return b.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const pkg = JSON.parse(cat('dsh/package.json'))
console.log('=== dsh/package.json 顶层字段 ===')
for (const k of Object.keys(pkg)) {
  const v = JSON.stringify(pkg[k])
  console.log(`  ${k}: ${v.length > 200 ? v.slice(0, 200) + '…' : v}`)
}

console.log('\n=== 与 preset 有关的依赖 ===')
for (const [k, v] of Object.entries(pkg.dependencies ?? {})) {
  if (/preset/i.test(k)) console.log(`  ${k}: ${v}`)
}

console.log('\n=== desktop-runtime.json 顶层键 ===')
const rt = JSON.parse(cat('dsh/desktop-runtime.json'))
console.log(' ', Object.keys(rt).join(', '))
for (const k of Object.keys(rt)) {
  if (/preset/i.test(k)) console.log(`  ${k}:`, JSON.stringify(rt[k]).slice(0, 300))
}

console.log('\n=== 桌面 App 依赖里有几个 agent-preset 相关包 ===')
const presets = Object.keys(pkg.dependencies ?? {}).filter((k) => /agent-preset/.test(k))
console.log(' ', presets.join('\n  ') || '(无)')
