/**
 * host 层测试：插件能不能被 cordis 加载、RPC 通道是否按约定挂上、
 * 端点是否拒绝缺参数而不是悄悄写盘。
 *
 * 这一层最容易出的问题是「插件列表里显示异常」——加载期抛错或 inject 声明不对，
 * 都只会在运行时暴露。所以这里用假 ctx 把加载路径走一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as plugin from '../src/index.js'
import { endpointFromPath, endpointFromRequestUrl, registerRpc, ok, fail, CHANNEL } from '../src/rpc.js'
import { makeEndpoints, parseSimpleYaml } from '../src/endpoints.js'

test('插件入口导出 cordis 需要的三样东西', () => {
  assert.equal(plugin.name, 'dsh-course-vault')
  assert.deepEqual(plugin.inject, ['webServer', 'profileContext'])
  assert.equal(typeof plugin.apply, 'function')
})

test('包清单声明了 DSH bundle 契约，且 patch 指向真实文件', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.main, 'src/index.js')
  assert.ok(fs.existsSync(path.join(root, pkg.dsh.bundle.patch)), 'patch 文件必须存在')

  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name:\s*dsh-course-vault/, 'patch 必须插入本插件')
  assert.match(patch, /insert:/)
})

test('apply() 在假 ctx 上不抛错，并挂上 /dsh-course 前缀路由', () => {
  const routes = []
  const logs = []
  const ctx = {
    profileContext: { name: 'default', home: 'C:\\fake-home', dir: 'C:\\fake-home\\profiles\\default' },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }

  plugin.apply(ctx)
  assert.equal(routes.length, 1, '应注册恰好一条路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, CHANNEL)
  assert.ok(logs.some((m) => m.includes('已加载')), '应有加载日志')
})

test('webServer 不可用时只告警，不抛错（插件仍可为 preset 工作）', () => {
  const logs = []
  const ctx = {
    profileContext: { name: 'default', home: 'C:\\fake-home' },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.ok(logs.some((m) => m.includes('通道未挂载')), '应提示通道未挂载')
})

test('endpointFromPath 只接受通道内的安全段（URL 规范化后）', () => {
  assert.equal(endpointFromPath('/dsh-course/course/export'), 'course/export')
  assert.equal(endpointFromPath('/dsh-course/runtime/get'), 'runtime/get')
  assert.equal(endpointFromPath('/other/course/export'), undefined)
  assert.equal(endpointFromPath('/dsh-course/'), undefined)
  assert.equal(endpointFromPath('not a url'), undefined)
  // 注意：new URL 会把 `..` 规范化掉，所以这份实现看不到 `..`；真正生效的是下面那份
  assert.equal(endpointFromPath('/dsh-course/a/../b'), 'b')
})

test('endpointFromRequestUrl 在规范化前就拒绝穿越段（白名单真正生效）', () => {
  assert.equal(endpointFromRequestUrl('/dsh-course/course/export'), 'course/export')
  assert.equal(endpointFromRequestUrl('/dsh-course/course/import?x=1'), 'course/import')
  assert.equal(endpointFromRequestUrl('/dsh-course/a/../b'), undefined, '原始路径里的 .. 必须被拒')
  assert.equal(endpointFromRequestUrl('/dsh-course/./a'), undefined)
  assert.equal(endpointFromRequestUrl('/dsh-course/a//b'), undefined)
  assert.equal(endpointFromRequestUrl('/dsh-course/'), undefined)
  // 非白名单字符（含 URL 编码后的 %2e%2e）一律拒绝
  assert.equal(endpointFromRequestUrl('/dsh-course/a%2e%2eb'), undefined)
  assert.equal(endpointFromRequestUrl('/dsh-course/a b'), undefined)
  assert.equal(endpointFromRequestUrl('/other/course/export'), undefined)
  assert.equal(endpointFromRequestUrl(''), undefined)
})

test('响应信封与官方客户端约定对称', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } })
  const f = fail('code', 'msg')
  assert.deepEqual(f, { ok: false, error: { code: 'code', message: 'msg', details: {} } })
})

test('registerRpc 在缺 webServer 时返回 null 而不是抛错', () => {
  const result = registerRpc({}, async () => {}, () => true)
  assert.equal(result, null)
})

test('parseSimpleYaml 能读课程卡的顶层键值', () => {
  const card = parseSimpleYaml(
    ['# 注释', 'id: llm-vla-v3', 'name: "LLM/VLA 手工编码课程 v3"', 'noCoreCode: true', 'order: 5', ''].join('\n'),
  )
  assert.equal(card.id, 'llm-vla-v3')
  assert.equal(card.name, 'LLM/VLA 手工编码课程 v3')
  assert.equal(card.noCoreCode, true)
  assert.equal(card.order, '5')
})

test('端点表齐全，且缺参数时明确报错而不是写盘', async () => {
  const endpoints = makeEndpoints(() => ({ home: 'C:\\fake-home', profileName: 'default', source: 'test' }))
  const expected = [
    'runtime/get',
    'preset/status',
    'preset/sync',
    'workspace/list',
    'vault/list',
    'vault/inspect',
    'course/card',
    'course/export',
    'course/import-plan',
    'course/import',
  ]
  for (const key of expected) assert.equal(typeof endpoints[key], 'function', `缺少端点 ${key}`)

  await assert.rejects(() => endpoints['course/export']({}), /缺少参数：workspace/)
  await assert.rejects(() => endpoints['vault/list']({}), /缺少参数：sessionsDir/)
  await assert.rejects(() => endpoints['vault/inspect']({}), /缺少参数：vaultPath/)
  await assert.rejects(() => endpoints['course/card']({}), /缺少参数：contentRoot/)
  await assert.rejects(() => endpoints['course/import']({}), /缺少参数：vaultPath/)
})

test('runtime/get 报告运行时事实与版本', async () => {
  const endpoints = makeEndpoints(() => ({ home: 'C:\\fake-home', profileName: 'default', source: 'profileContext' }))
  const value = await endpoints['runtime/get']()
  assert.equal(value.plugin.name, 'dsh-course-vault')
  assert.equal(value.dshHome, 'C:\\fake-home')
  assert.equal(value.profileName, 'default')
  assert.equal(value.channel, CHANNEL)
})

test('course/card 对不存在的课程文件夹明确报错', async () => {
  const endpoints = makeEndpoints(() => ({ home: 'C:\\fake-home', profileName: 'default', source: 'test' }))
  await assert.rejects(
    () => endpoints['course/card']({ contentRoot: 'C:\\definitely\\not\\there' }),
    /课程文件夹不存在/,
  )
})

test('course/card 读得懂课程卡并如实报告关键文件缺失', async () => {
  const root = fs.mkdtempSync(path.join(await import('node:os').then((m) => m.default.tmpdir()), 'dsvault-card-'))
  fs.writeFileSync(path.join(root, 'course.config.yaml'), 'name: 测试课\nteacherPrompt: RULES.md\n', 'utf8')
  fs.writeFileSync(path.join(root, 'RULES.md'), '# 规则\n', 'utf8')
  const endpoints = makeEndpoints(() => ({ home: 'C:\\fake-home', profileName: 'default', source: 'test' }))
  const card = await endpoints['course/card']({ contentRoot: root })
  assert.equal(card.card.name, '测试课')
  // 课程卡指定的教师规则存在 → present
  assert.equal(card.files.teacherPrompt.name, 'RULES.md')
  assert.equal(card.files.teacherPrompt.present, true)
  // 学习档案没建 → 必须如实报 false，不能假装有
  assert.equal(card.files.learningState.present, false)
  fs.rmSync(root, { recursive: true, force: true })
})
