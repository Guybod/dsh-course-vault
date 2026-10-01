import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

import { projectKey, encodeSegment, samePath, assertSafeRelative } from '../src/core/paths.js'
import { scanFrames, readHeader, replaceHeader, validateTranscript } from '../src/core/zstd-codec.js'

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** 找一个真实 transcript 用于对照验证；没有就跳过（CI 上不该有这个文件）。 */
function findRealTranscript() {
  if (!fs.existsSync(SESSIONS_ROOT)) return null
  for (const project of fs.readdirSync(SESSIONS_ROOT)) {
    const pdir = path.join(SESSIONS_ROOT, project)
    if (!fs.statSync(pdir).isDirectory()) continue
    for (const sid of fs.readdirSync(pdir)) {
      const sdir = path.join(pdir, sid)
      if (!fs.statSync(sdir).isDirectory()) continue
      for (const name of fs.readdirSync(sdir)) {
        if (name.startsWith('session.') && name.endsWith('.zstd')) {
          return { project, dir: sdir, file: path.join(sdir, name) }
        }
      }
    }
  }
  return null
}

test('projectKey 与 DSH 实际目录名逐字节一致', () => {
  // 这条断言用本机真实目录名做锚点：规则一旦漂移，跨机导入会写到 DSH 找不到的目录
  const real = findRealTranscript()
  if (real) {
    const header = readHeader(fs.readFileSync(real.file)).header
    assert.equal(projectKey(header.cwd), real.project, 'projectKey(cwd) 必须等于磁盘上的项目目录名')
  }
  assert.equal(projectKey('C:\\Users\\MLTZ\\Documents\\deepseek-harness\\default-workspace'),
    '--C-Users-MLTZ-Documents-deepseek-harness-default-workspace--')
})

test('projectKey 处理空格、盘符、连续分隔符', () => {
  assert.equal(projectKey('D:\\code\\LLM_VLA_Handwritten_Course'), '--D-code-LLM_VLA_Handwritten_Course--')
  assert.equal(projectKey('D:\\code\\My Course'), '--D-code-My~0020Course--')
  assert.equal(projectKey('C:\\\\a\\\\b'), '--C-a-b--')
  assert.equal(projectKey('\\\\?\\UNC'), '--~003F-UNC--')
})

test('encodeSegment 转义与特殊段', () => {
  assert.equal(encodeSegment('session-abc_123'), 'session-abc_123')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

test('samePath 保守比较', () => {
  assert.equal(samePath('C:\\code\\A', 'c:/code/a/'), true)
  assert.equal(samePath('C:\\code\\A', 'C:\\code\\B'), false)
  assert.equal(samePath(undefined, 'C:\\code\\A'), false)
})

test('assertSafeRelative 拒绝穿越与绝对路径', () => {
  assert.equal(assertSafeRelative('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(assertSafeRelative('a\\b'), 'a/b')
  assert.throws(() => assertSafeRelative('../x'))
  assert.throws(() => assertSafeRelative('a/../../x'))
  assert.throws(() => assertSafeRelative('C:\\x'))
  assert.throws(() => assertSafeRelative('/etc/passwd'))
})

test('真实 transcript：能完整解码、header 可读', () => {
  const real = findRealTranscript()
  if (!real) return // 无真实文件时跳过
  const buf = fs.readFileSync(real.file)
  const { header, frameCount } = readHeader(buf)
  assert.equal(header.type, 'session')
  assert.ok(header.id.length > 0)
  assert.equal(typeof header.cwd, 'string')
  assert.ok(frameCount > 1, '真实会话应有多个 frame')
  assert.ok(header.delegationDepth === 0 || header.delegationDepth > 0)

  const v = validateTranscript(buf)
  assert.equal(v.frameCount, frameCount)
  assert.ok(v.recordCount > 1)
  assert.deepEqual(v.header, header)
})

test('只替换 header frame 后：其余 frame 字节完全不变、仍可解码', () => {
  const real = findRealTranscript()
  if (!real) return
  const buf = fs.readFileSync(real.file)
  const { header } = readHeader(buf)
  const { frames } = scanFrames(buf)

  const newCwd = 'D:\\code\\LLM_VLA_Handwritten_Course'
  const next = replaceHeader(buf, { ...header, cwd: newCwd })

  // 1) 新 header 生效
  const after = readHeader(next)
  assert.equal(after.header.cwd, newCwd)
  assert.equal(after.header.id, header.id, 'id 必须保持不变')
  assert.equal(after.header.agentPreset, header.agentPreset, 'agentPreset 必须保持不变')
  assert.equal(after.header.delegationDepth, header.delegationDepth)

  // 2) 除第一个 frame 外，所有原始 frame 字节逐一相同（无损的证据）
  const { frames: newFrames } = scanFrames(next)
  assert.equal(newFrames.length, frames.length, 'frame 数量必须不变')
  for (let i = 1; i < frames.length; i += 1) {
    const orig = buf.subarray(frames[i].start, frames[i].end)
    const now = next.subarray(newFrames[i].start, newFrames[i].end)
    assert.ok(orig.equals(now), `第 ${i} 个 frame 字节必须原样保留`)
  }

  // 3) 整份新文件仍通过完整校验，记录数不变
  const before = validateTranscript(buf)
  const afterAll = validateTranscript(next)
  assert.equal(afterAll.recordCount, before.recordCount, '记录数必须不变')

  // 4) 新 header frame 带 checksum（与 DSH 写出风格一致）
  const newHeaderFrame = next.subarray(newFrames[0].start, newFrames[0].end)
  assert.equal((newHeaderFrame[4] >> 2) & 1, 1, '新 header frame 必须带 checksum 标志')
  assert.equal(zlib.zstdDecompressSync(newHeaderFrame).toString('utf8').endsWith('\n'), true)
})

test('损坏文件被拒绝：篡改 frame 内容导致 checksum 失败', () => {
  const real = findRealTranscript()
  if (!real) return
  const buf = Buffer.from(fs.readFileSync(real.file))
  const { frames } = scanFrames(buf)
  // 翻掉第二个 frame 中间某个 bit
  const target = frames[1]
  const mid = Math.floor((target.start + target.end) / 2)
  buf[mid] = buf[mid] ^ 0xff
  assert.throws(() => validateTranscript(buf), /解压失败|checksum/)
})
