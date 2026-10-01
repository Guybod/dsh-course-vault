/**
 * 课程模式 preset 的同步与自检测试。
 *
 * 关键断言：同步后目标目录里必须出现 `agent.cordis.yml`（DSH 靠它挂载组装）、
 * `preset.yml`（显示名）与课程技能；且只能动本插件拥有的文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { syncCoursePreset, presetStatus, presetTargetDir, presetSourceDir } from '../src/core/preset.js'

test('preset 源目录存在且含必需的组装文件', () => {
  const src = presetSourceDir()
  assert.ok(fs.existsSync(path.join(src, 'agent.cordis.yml')), '缺少 agent.cordis.yml')
  assert.ok(fs.existsSync(path.join(src, 'preset.yml')), '缺少 preset.yml')
  assert.ok(fs.existsSync(path.join(src, 'skills', 'course-tutor', 'SKILL.md')), '缺少课程技能')
})

test('同步到全新 DSH_HOME：文件齐备，且幂等', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset-'))

  const first = await syncCoursePreset({ dshHome: home })
  assert.equal(first.ok, true)
  assert.deepEqual(
    [...first.written].sort(),
    ['agent.cordis.yml', 'preset.yml', 'skills/course-tutor/SKILL.md'],
  )
  const target = presetTargetDir(home)
  for (const rel of ['agent.cordis.yml', 'preset.yml', 'skills/course-tutor/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(target, rel)), `应写入 ${rel}`)
  }

  // 幂等：第二次全部跳过，不重写
  const second = await syncCoursePreset({ dshHome: home })
  assert.equal(second.written.length, 0)
  assert.equal(second.skipped, 3)

  // 改坏一个文件后，再 sync 只修那一个
  fs.writeFileSync(path.join(target, 'preset.yml'), 'tampered', 'utf8')
  const third = await syncCoursePreset({ dshHome: home })
  assert.deepEqual(third.written, ['preset.yml'])

  const status = await presetStatus(home)
  assert.equal(status.installed, true)
  assert.equal(status.hasMetadata, true)
  assert.equal(status.hasSkill, true)
  assert.equal(status.upToDate, true)

  fs.rmSync(home, { recursive: true, force: true })
})

test('清理陈旧文件，但不碰别的 preset', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset2-'))
  await syncCoursePreset({ dshHome: home })
  const target = presetTargetDir(home)

  // 本插件目录里的陈旧文件应被清掉
  fs.writeFileSync(path.join(target, 'stale.md'), 'old', 'utf8')
  // 用户自己创建的另一个 preset 必须原样保留
  const other = path.join(home, '.agent-presets', 'mine')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'agent.cordis.yml'), 'mine', 'utf8')

  const res = await syncCoursePreset({ dshHome: home })
  assert.deepEqual(res.removed, ['stale.md'])
  assert.equal(fs.existsSync(path.join(target, 'stale.md')), false)
  assert.equal(fs.readFileSync(path.join(other, 'agent.cordis.yml'), 'utf8'), 'mine')

  fs.rmSync(home, { recursive: true, force: true })
})

test('组装文件里的相对技能路径指向 preset 内部（保证随 preset 迁移）', () => {
  const yml = fs.readFileSync(path.join(presetSourceDir(), 'agent.cordis.yml'), 'utf8')
  assert.match(yml, /customSkillDirs:\s*\n\s*-\s*\.\/skills/, 'skill-filesystem 必须以相对路径引用 ./skills')
  // 人设必须真的换成了授课老师，而不是留 standard 的编码 agent 文案
  assert.match(yml, /课程/, 'persona 应包含课程相关文案')
  assert.match(yml, /逐级提示|H0/, 'persona 应写明提示升级阶梯')
  assert.doesNotMatch(yml, /You are a coding agent powered by/, 'persona 不应残留 standard 的原文')

  const meta = fs.readFileSync(path.join(presetSourceDir(), 'preset.yml'), 'utf8')
  assert.match(meta, /name: 课程模式/)
  assert.match(meta, /order: 5/, '应排在出厂 4 个模式之后')
})
