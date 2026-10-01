/**
 * 课程模式自检测试。
 *
 * 重点覆盖那次踩坑的根因：**两种版本两套 preset 形态**。
 *  - 0.2.x（桌面端）：preset 是声明式行，注册表不扫目录 → 靠插件自带的 `cordis.patch.yml`
 *  - 0.1.x（旧 CLI）：preset 是目录 → 靠 `preset/course/` 同步到 `$DSH_HOME/.agent-presets/course`
 *
 * 自检必须能**区分**这两种形态，而不是拿旧目录的存在与否乱报。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  syncCoursePreset,
  presetStatus,
  presetTargetDir,
  presetSourceDir,
  patchPath,
} from '../src/core/preset.js'

test('0.2.x 主形态：插件自带补丁，且声明了课程模式', () => {
  const p = patchPath()
  assert.ok(fs.existsSync(p), '缺少 cordis.patch.yml（0.2.x 靠它生效）')
  const text = fs.readFileSync(p, 'utf8')
  assert.match(text, /^-\s*insert:/m, '补丁顶层必须是 insert 列表')
  assert.match(text, /name:\s*'@deepseek-ai\/dsh-agent-preset'/, '必须插入 preset 声明行')
  assert.match(text, /config:\s*\n\s*id:\s*course\b/, 'preset 的 config.id 必须是 course')
  assert.match(text, /order:\s*5/, '应排在出厂 4 个模式之后')
  // 子插件行必须来自桌面端标准模式（含这几个 0.2.0 才有的行）
  for (const id of ['persona', 'tool-fs', 'tool-skill', 'planning', 'compaction', 'delegation']) {
    assert.match(text, new RegExp(`- id: ${id}\\b`), `缺少子插件行 ${id}`)
  }
  // persona 必须换成课程老师，且用 0.2.0 的 prefix/suffix（不是旧版的 text）
  assert.match(text, /prefix:/, 'persona 应使用 prefix（0.2.0 方言）')
  assert.doesNotMatch(text, /You are a coding agent powered by/, '不应残留 standard 的原文 persona')
})

test('0.1.x 兼容形态：目录源存在且含必需文件', () => {
  const src = presetSourceDir()
  assert.ok(fs.existsSync(path.join(src, 'agent.cordis.yml')), '缺少 agent.cordis.yml')
  assert.ok(fs.existsSync(path.join(src, 'preset.yml')), '缺少 preset.yml')
  assert.ok(fs.existsSync(path.join(src, 'skills', 'course-tutor', 'SKILL.md')), '缺少课程技能')
})

test('同步（0.1.x 形态）到全新 DSH_HOME：文件齐备且幂等', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset-'))
  const first = await syncCoursePreset({ dshHome: home })
  assert.equal(first.ok, true)
  const expectedFiles = ['agent.cordis.yml', 'persona.yml', 'preset.yml', 'skills/course-tutor/SKILL.md']
  assert.deepEqual([...first.written].sort(), [...expectedFiles].sort())
  const target = presetTargetDir(home)
  for (const rel of expectedFiles) {
    assert.ok(fs.existsSync(path.join(target, rel)), `应写入 ${rel}`)
  }

  const second = await syncCoursePreset({ dshHome: home })
  assert.equal(second.written.length, 0)
  assert.equal(second.skipped, expectedFiles.length)

  fs.writeFileSync(path.join(target, 'preset.yml'), 'tampered', 'utf8')
  const third = await syncCoursePreset({ dshHome: home })
  assert.deepEqual(third.written, ['preset.yml'])

  fs.rmSync(home, { recursive: true, force: true })
})

test('同步清理陈旧文件，但不碰别的 preset', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset2-'))
  await syncCoursePreset({ dshHome: home })
  const target = presetTargetDir(home)

  fs.writeFileSync(path.join(target, 'stale.md'), 'old', 'utf8')
  const other = path.join(home, '.agent-presets', 'mine')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'agent.cordis.yml'), 'mine', 'utf8')

  const res = await syncCoursePreset({ dshHome: home })
  assert.deepEqual(res.removed, ['stale.md'])
  assert.equal(fs.existsSync(path.join(target, 'stale.md')), false)
  assert.equal(fs.readFileSync(path.join(other, 'agent.cordis.yml'), 'utf8'), 'mine')

  fs.rmSync(home, { recursive: true, force: true })
})

test('自检区分两种形态：主形态看补丁，不靠旧目录判断', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset3-'))

  // 全新 home、没有旧目录：主形态（补丁）依然应被认定有效
  const bare = await presetStatus(home)
  assert.equal(bare.patch.present, true, '补丁应存在')
  assert.equal(bare.patch.declaresCourse, true, '补丁应声明课程模式')
  assert.equal(bare.effective, 'patch (DSH 0.2.x)', '全新机器上应认定为主形态')
  assert.equal(bare.legacyDir.installed, false, '旧目录形态此时未安装')

  // 只装了旧目录形态时，如果没有补丁才回退（这里补丁存在，仍以主形态为准）
  await syncCoursePreset({ dshHome: home })
  const both = await presetStatus(home)
  assert.equal(both.effective, 'patch (DSH 0.2.x)', '主形态优先')
  assert.equal(both.legacyDir.installed, true, '旧目录也应被如实报告为已安装')

  fs.rmSync(home, { recursive: true, force: true })
})

test('自检能读 roster（两代服务名都试），并如实报告课程模式是否可见', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-preset4-'))

  // 0.2.x 服务名
  const ctx02 = {
    get: (k) =>
      k === 'agentPresetRegistry'
        ? { list: async () => [{ id: 'standard' }, { id: 'course' }] }
        : undefined,
  }
  const s2 = await presetStatus(home, ctx02)
  assert.equal(s2.roster.total, 2)
  assert.equal(s2.roster.courseVisible, true)
  assert.deepEqual(s2.roster.ids, ['standard', 'course'])

  // 0.1.x 服务名
  const ctx01 = {
    get: (k) => (k === 'agentPresets' ? { list: async () => [{ id: 'standard', broken: '坏了' }] } : undefined),
  }
  const s1 = await presetStatus(home, ctx01)
  assert.equal(s1.roster.courseVisible, false, 'roster 里没有 course 时必须如实报 false')
  assert.equal(s1.roster.broken.length, 1)

  // 没有 roster 服务时不报错，roster 为 null
  const s0 = await presetStatus(home, { get: () => undefined })
  assert.equal(s0.roster, null)

  fs.rmSync(home, { recursive: true, force: true })
})
