/**
 * 「一键完整包」测试：课程内容 + 会话记录打成一个 .dsvault，再解到另一个位置。
 *
 * 用真实会话（本机 default-workspace 那条）配一个自造的假课程文件夹，
 * 覆盖内容段的打包 / 排除 / 差异检测 / 冲突策略，以及完整包的端到端往返。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { exportWorkspaceSessions, inspectVault } from '../src/core/export.js'
import { importFullVault } from '../src/core/import.js'
import { collectContentFiles } from '../src/core/content.js'
import { sessionsForWorkspace } from '../src/core/session-store.js'
import { validateTranscript } from '../src/core/zstd-codec.js'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const REAL_HOME = path.join(os.homedir(), '.dsh')
const SRC_CWD = 'C:\\Users\\MLTZ\\Documents\\deepseek-harness\\default-workspace'
const hasSessions = fs.existsSync(path.join(REAL_HOME, 'sessions'))

/** 造一个像真课程的文件夹：大纲/讲义/手写代码/测验/学习档案 + 三类必须被排除的干扰项。 */
function makeCourseDir(tag = 'a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsvault-course-${tag}-`))
  fs.mkdirSync(path.join(root, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(root, 'projects', 'P01'), { recursive: true })
  fs.mkdirSync(path.join(root, 'quiz'), { recursive: true })
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true }) // 存档目录，必须排除
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }) // 必须排除
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true }) // 必须排除

  fs.writeFileSync(path.join(root, '03_LEARNING_STATE.md'), '# 学习档案\n当前：P01.01\n', 'utf8')
  fs.writeFileSync(path.join(root, '01_TEACHER_PROMPT.md'), '# 教师规则\n不代写核心实现。\n', 'utf8')
  fs.writeFileSync(path.join(root, 'lessons', 'U02.md'), '# U02 前向函数\n', 'utf8')
  fs.writeFileSync(path.join(root, 'projects', 'P01', 'PRACTICE.ipynb'), '{"cells":[]}', 'utf8')
  fs.writeFileSync(path.join(root, 'quiz', 'Q01.md'), '# 测验一\n', 'utf8')
  fs.writeFileSync(path.join(root, 'sessions', 'old.dsvault'), 'SHOULD-NOT-BE-PACKED', 'utf8')
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
  fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), '// nope', 'utf8')
  return root
}

test('collectContentFiles 排除 sessions / .git / node_modules', async () => {
  const root = makeCourseDir('excl')
  const files = await collectContentFiles(root, { skipSiblings: [path.join(root, 'sessions')] })
  const rels = files.map((f) => f.rel)
  assert.ok(rels.includes('03_LEARNING_STATE.md'))
  assert.ok(rels.includes('lessons/U02.md'))
  assert.ok(rels.includes('projects/P01/PRACTICE.ipynb'))
  assert.ok(!rels.some((r) => r.includes('.git')), '.git 必须被排除')
  assert.ok(!rels.some((r) => r.includes('node_modules')), 'node_modules 必须被排除')
  assert.ok(!rels.some((r) => r.startsWith('sessions')), 'sessions 必须被排除')
  fs.rmSync(root, { recursive: true, force: true })
})

test('只有课程内容、还没有会话时也能导出留档', async () => {
  const course = makeCourseDir('nosession')
  const sessionsDir = path.join(course, 'sessions')
  const res = await exportWorkspaceSessions({
    dshHome: REAL_HOME,
    workspace: 'C:\\definitely\\no\\sessions\\here',
    contentRoot: course,
    sessionsDir,
    name: 'content-only.dsvault',
  })
  assert.equal(res.ok, true)
  assert.equal(res.sessions, 0)

  const inspected = await inspectVault(res.output)
  assert.equal(inspected.kind, 'course-full')
  assert.ok(inspected.manifest.content.length >= 5)
  for (const c of inspected.contentChecks) assert.equal(c.ok, true, `${c.path}: ${c.reason}`)
  // sessions 目录里的旧包不能被套进新包
  assert.ok(!inspected.entries.some((e) => e.includes('old.dsvault')))
  fs.rmSync(course, { recursive: true, force: true })
})

test('一键完整包端到端：内容 + 真实会话 → 另一个位置解出来', { skip: !hasSessions }, async () => {
  const course = makeCourseDir('full')
  const sessionsDir = path.join(course, 'sessions')
  const res = await exportWorkspaceSessions({
    dshHome: REAL_HOME,
    workspace: SRC_CWD,
    contentRoot: course,
    sessionsDir,
    all: true,
    name: 'full.dsvault',
  })
  assert.equal(res.skipped, false)
  assert.ok(res.sessions >= 1, '应该有真实会话进包')

  const inspected = await inspectVault(res.output)
  assert.equal(inspected.kind, 'course-full')
  assert.equal(inspected.checks.length, res.sessions)
  for (const c of inspected.checks) assert.equal(c.ok, true, `${c.id}: ${c.reason}`)
  for (const c of inspected.contentChecks) assert.equal(c.ok, true, `${c.path}: ${c.reason}`)

  // ── 解到「另一台电脑」：内容落点全新，会话落进隔离的假 DSH_HOME ──
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-home-'))
  const targetCourse = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-tgt-')), 'LLM_VLA_Handwritten_Course')
  const targetCwd = 'D:\\code\\LLM_VLA_Handwritten_Course'

  // dry-run 先看差异：不能动任何文件
  const dry = await importFullVault({
    vaultPath: res.output,
    dshHome: targetHome,
    contentTarget: targetCourse,
    targetCwd,
  })
  assert.equal(dry.applied, false)
  assert.equal(dry.sessions.written.length, 0)
  assert.equal(dry.content.written.length, 0)
  assert.equal(dry.content.summary.create, inspected.manifest.content.length)
  assert.equal(fs.existsSync(path.join(targetHome, 'sessions')), false, 'dry-run 不能建目录')

  // 真正导入
  const applied = await importFullVault({
    vaultPath: res.output,
    dshHome: targetHome,
    contentTarget: targetCourse,
    targetCwd,
    apply: true,
  })
  assert.equal(applied.applied, true)
  assert.equal(applied.sessions.written.length, res.sessions)
  assert.equal(applied.content.written.length, inspected.manifest.content.length)

  // 内容：文件都在，内容一致
  for (const record of inspected.manifest.content) {
    const target = path.join(targetCourse, record.path)
    assert.ok(fs.existsSync(target), `内容文件应存在：${record.path}`)
    const data = fs.readFileSync(target)
    assert.equal(validateOrHash(data), record.sha256, `内容 sha256 应一致：${record.path}`)
  }

  // 会话：cwd 已重写、仍可解析、记录数不变
  const srcSessions = await sessionsForWorkspace(REAL_HOME, SRC_CWD)
  for (const w of applied.sessions.written) {
    const validated = validateTranscript(fs.readFileSync(w.path))
    assert.equal(validated.header.cwd, targetCwd, 'header.cwd 必须重写为目标路径')
    const src = srcSessions.find((s) => s.id === w.id)
    const srcCount = validateTranscript(fs.readFileSync(src.transcript)).recordCount
    assert.equal(validated.recordCount, srcCount, '记录数必须不变')
  }

  // 幂等：再导一次，内容全 same、会话全 skip，且不动冲突
  const again = await importFullVault({
    vaultPath: res.output,
    dshHome: targetHome,
    contentTarget: targetCourse,
    targetCwd,
    apply: true,
  })
  assert.equal(again.sessions.written.length, 0)
  assert.equal(again.content.written.length, 0)
  assert.equal(again.content.summary.same, inspected.manifest.content.length)

  // 冲突策略：本机改了学习档案 → 默认不覆盖，replace 才覆盖
  const statePath = path.join(targetCourse, '03_LEARNING_STATE.md')
  fs.writeFileSync(statePath, '# 我在笔记本上写的进度\nP01.01 已完成\n', 'utf8')
  const conflictDry = await importFullVault({
    vaultPath: res.output,
    dshHome: targetHome,
    contentTarget: targetCourse,
    targetCwd,
  })
  assert.equal(conflictDry.content.summary.conflict, 1, '被本地改过的文件应报冲突')
  const conflictApplied = await importFullVault({
    vaultPath: res.output,
    dshHome: targetHome,
    contentTarget: targetCourse,
    targetCwd,
    apply: true,
  })
  assert.equal(conflictApplied.content.written.length, 0, '默认不覆盖冲突')
  assert.deepEqual(conflictApplied.content.skipped, ['03_LEARNING_STATE.md'])
  assert.match(fs.readFileSync(statePath, 'utf8'), /笔记本/, '本地改动必须保留')

  fs.rmSync(course, { recursive: true, force: true })
  fs.rmSync(targetHome, { recursive: true, force: true })
  fs.rmSync(path.dirname(targetCourse), { recursive: true, force: true })
})

/** 内容文件落盘后的 sha256，用于与清单比对。 */
function validateOrHash(data) {
  return sha256(data)
}
