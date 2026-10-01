// 最小 asar 读取器：asar = [pickle 头][JSON 索引][文件数据]。
// Node 内置不支持 asar，这里手工解析索引，只取需要的文件。
import fs from 'node:fs'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'

function readAsarIndex(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    // 前 8 字节是 pickle 长度信息；索引 JSON 从偏移 8 开始，长度由 uint32 给出
    const jsonLen = head.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(jsonLen)
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
    const index = JSON.parse(jsonBuf.toString('utf8'))
    // 数据区起点 = 16 + jsonLen，向上按 4 字节对齐
    const dataStart = 16 + jsonLen + ((4 - ((16 + jsonLen) % 4)) % 4)
    return { fd, index, dataStart }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
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
console.log('asar 内文件总数:', all.length)

const targets = all.filter((f) =>
  f.path.includes('agent-presets') || f.path.includes('presets/') || f.path.endsWith('.cordis.yml'),
)
console.log('\n=== 与 preset 相关的条目（前 20）===')
for (const t of targets.slice(0, 20)) console.log(' ', t.path, t.size)

// 找 desktop 的 web-app patch 与 agent-presets 实现
const interest = [
  'dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
  'dsh/node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js',
  'dsh/config/agent-presets/standard/preset.yml',
]
console.log('\n=== 关键文件是否存在 ===')
for (const p of interest) {
  const hit = all.find((f) => f.path === p)
  console.log(hit ? `✅ ${p}  (${hit.size} B)` : `❌ 不在 asar: ${p}`)
}

// 若 patch 在，打印 agent-presets 那一段
const patchHit = all.find((f) => f.path.endsWith('dsh-web-app/cordis.patch.yml'))
if (patchHit) {
  const text = readEntry(fd, dataStart, patchHit).toString('utf8')
  const idx = text.indexOf('agent-presets')
  console.log('\n=== asar 内 web-app patch 的 agent-presets 段 ===')
  console.log(idx >= 0 ? text.slice(Math.max(0, idx - 400), idx + 300) : '(未找到 agent-presets)')
} else {
  console.log('\nasar 内没有独立的 dsh-web-app patch —— 说明桌面端把组合打进了别处（可能已 bundle 进启动代码）')
}
fs.closeSync(fd)
