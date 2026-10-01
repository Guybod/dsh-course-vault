import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { zipSync, listZip, readZipEntry, crc32 } from '../src/core/zip.js'

test('crc32 与已知值一致', () => {
  // '123456789' 的 CRC32 标准测试向量
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('', 'utf8')), 0)
})

test('zip 写入后可被自己读回，内容与 CRC 一致', () => {
  const buf = zipSync([
    { name: 'manifest.json', data: Buffer.from('{"a":1}\n', 'utf8') },
    { name: 'sessions/x/session.v4.jsonl.zstd', data: Buffer.from([1, 2, 3, 4, 5]) },
  ])
  const names = listZip(buf).map((e) => e.name)
  assert.deepEqual(names, ['manifest.json', 'sessions/x/session.v4.jsonl.zstd'])
  assert.equal(readZipEntry(buf, 'manifest.json').toString('utf8'), '{"a":1}\n')
  assert.deepEqual([...readZipEntry(buf, 'sessions/x/session.v4.jsonl.zstd')], [1, 2, 3, 4, 5])
})

test('非 ASCII 文件名标志位置位且可读回', () => {
  const buf = zipSync([{ name: '课程/大纲.md', data: Buffer.from('大纲', 'utf8') }])
  const entry = listZip(buf)[0]
  assert.equal(entry.name, '课程/大纲.md')
  assert.equal(readZipEntry(buf, '课程/大纲.md').toString('utf8'), '大纲')
})

test('拒绝目录穿越与重复条目', () => {
  assert.throws(() => zipSync([{ name: '../evil.txt', data: Buffer.from('x') }]))
  assert.throws(() => zipSync([{ name: 'C:\\evil.txt', data: Buffer.from('x') }]))
  assert.throws(() =>
    zipSync([
      { name: 'a.txt', data: Buffer.from('1') },
      { name: 'a.txt', data: Buffer.from('2') },
    ]),
  )
})

test('CRC 被篡改时 readZipEntry 报错', () => {
  const buf = zipSync([{ name: 'a.txt', data: Buffer.from('hello') }])
  const copy = Buffer.from(buf)
  // 改掉数据区一个字节（数据紧跟在 local header+name 之后）
  const entry = listZip(copy)[0]
  const dataStart = entry.offset + 30 + 'a.txt'.length
  copy[dataStart] = copy[dataStart] ^ 0xff
  assert.throws(() => readZipEntry(copy, 'a.txt'), /CRC32 校验失败/)
})

test('产物能被 Windows 自带解压（Expand-Archive）打开', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-ziptest-'))
  const zipPath = path.join(tmp, 't.zip')
  const outDir = path.join(tmp, 'out')
  fs.writeFileSync(zipPath, zipSync([
    { name: 'manifest.json', data: Buffer.from('{"ok":true}\n', 'utf8') },
    { name: 'a/b.txt', data: Buffer.from('中文内容\n', 'utf8') },
  ]))
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`], { stdio: 'inherit' })
  assert.equal(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'), '{"ok":true}\n')
  assert.equal(fs.readFileSync(path.join(outDir, 'a', 'b.txt'), 'utf8'), '中文内容\n')
  fs.rmSync(tmp, { recursive: true, force: true })
})
