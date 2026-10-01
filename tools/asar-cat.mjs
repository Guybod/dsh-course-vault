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
const { fd, index, dataStart } = readAsarIndex(ASAR)
const all = []
findFiles(index, '', all)
const read = (entry) => {
  const buf = Buffer.alloc(Number(entry.size))
  fs.readSync(fd, buf, 0, buf.length, dataStart + Number(entry.offset))
  return buf
}
const want = process.argv[2]
const hit = all.find((f) => f.path === want)
console.log(hit ? read(hit).toString('utf8') : `(不在 asar: ${want})`)
fs.closeSync(fd)
