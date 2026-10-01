import fs from 'node:fs'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
function readAsarIndex(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
  const index = JSON.parse(jsonBuf.toString('utf8'))
  const dataStart = 16 + jsonLen + ((4 - ((16 + jsonLen) % 4)) % 4)
  return { fd, index, dataStart }
}
function findFiles(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) findFiles(entry, p, out)
    else out.push({ path: p, size: entry.size, offset: entry.offset })
  }
}
function readEntry(fd, dataStart, entry) {
  const buf = Buffer.alloc(Number(entry.size))
  fs.readSync(fd, buf, 0, buf.length, dataStart + Number(entry.offset))
  return buf
}

const { fd, index, dataStart } = readAsarIndex(ASAR)
const all = []
findFiles(index, '', all)

console.log('=== 所有名含 preset / 目录名含 agent-presets 的条目 ===')
for (const f of all.filter((f) => /preset/i.test(f.path))) {
  if (/agent-preset|config\/agent|roster/i.test(f.path)) console.log('  ★', f.path, f.size)
}
console.log('\n=== dsh/ 下的顶层目录 ===')
const tops = new Set()
for (const f of all) {
  if (!f.path.startsWith('dsh/')) continue
  const seg = f.path.split('/').slice(0, 2).join('/')
  tops.add(seg)
}
console.log([...tops].sort().slice(0, 40).join('\n'))

console.log('\n=== web-app patch 里的 preset 相关行 ===')
const patch = all.find((f) => f.path === 'dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
const text = readEntry(fd, dataStart, patch).toString('utf8')
for (const line of text.split('\n')) {
  if (/preset/i.test(line)) console.log('  ', line.trim())
}

console.log('\n=== asar 里有没有 agent-presets 这个字符串（在任何 .yml/.js 条目里）===')
let hits = 0
for (const f of all) {
  if (!/\.(yml|yaml|js|mjs|cjs)$/.test(f.path)) continue
  if (f.size > 3_000_000) continue
  const s = readEntry(fd, dataStart, f).toString('utf8')
  if (s.includes('agent-presets')) {
    hits++
    if (hits <= 6) console.log('  ', f.path)
  }
}
console.log('  命中文件数:', hits)
fs.closeSync(fd)
