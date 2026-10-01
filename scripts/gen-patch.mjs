// 生成 cordis.patch.yml：把「课程模式」做成 0.2.0 形态的 preset 声明。
//
// 为什么必须这么做：桌面端（DSH 0.2.0-rc.2）用 @deepseek-ai/dsh-agent-preset-registry，
// preset 是**声明式**的——注册表不扫描任何目录。内置 4 个模式是
// `dsh-web-app/presets/{standard,code,minimal,cordis}.patch.yml` 里的
// `@deepseek-ai/dsh-agent-preset` 行。
//
// 因此本插件贡献课程模式的正确方式，是插入一行同构的声明：
//   - id: preset-course
//     name: '@deepseek-ai/dsh-agent-preset'
//     config:
//       id: course
//       name/description/order
//       plugins: [ … ]
//
// 子插件行**直接取自桌面端自带的标准模式定义**，只替换 persona，这样：
//   · 字段名一定与当前版本匹配（0.2.0 的 persona 用 prefix/suffix，不是 text）
//   · 标准模式的能力一个不少
//
// 数据来源：asar 内 `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASAR = process.argv[2] ?? 'D:/DeepSeek Harness/resources/app.asar'
const STANDARD_PATCH = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const OUT = path.join(ROOT, 'cordis.patch.yml')
const PERSONA_SRC = path.join(ROOT, 'preset/course/persona.yml')

// 第二个参数可指向官方 CLI 或隔离提取的 DSH runtime，使用其自带的 YAML 方言。
const require = createRequire(path.resolve(process.argv[3] ?? path.join(ROOT, '.dev/dsh'), 'package.json'))
const yaml = require('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => ({ __jsExpr: data }),
  // 回写：把表达式对象还原成 `!!js 表达式` 标量
  represent: (data) => data.__jsExpr,
  predicate: (data) => data !== null && typeof data === 'object' && typeof data.__jsExpr === 'string',
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

/** 从 asar 取一个文件。 */
function readFromAsar(inner) {
  const fd = fs.openSync(ASAR, 'r')
  try {
    const h = Buffer.alloc(16)
    fs.readSync(fd, h, 0, 16, 0)
    const n = h.readUInt32LE(12)
    const j = Buffer.alloc(n)
    fs.readSync(fd, j, 0, n, 16)
    const index = JSON.parse(j.toString('utf8'))
    const dataStart = 16 + n + ((4 - ((16 + n) % 4)) % 4)
    const parts = inner.split('/')
    let node = index
    for (const part of parts) node = node.files?.[part]
    if (!node) throw new Error(`asar 内不存在：${inner}`)
    const buf = Buffer.alloc(Number(node.size))
    fs.readSync(fd, buf, 0, buf.length, dataStart + Number(node.offset))
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// ── 1) 取桌面端标准模式的定义 ────────────────────────────────────────────────
const standardText = readFromAsar(STANDARD_PATCH)
const standardDoc = yaml.load(standardText, { schema })
const stdRow = standardDoc[0].insert.find((r) => r.name === '@deepseek-ai/dsh-agent-preset')
if (!stdRow) throw new Error('标准模式定义里找不到 @deepseek-ai/dsh-agent-preset 行')
const plugins = stdRow.config.plugins
console.log('取到标准模式子插件行:', plugins.length)

// ── 2) 替换 persona 为课程老师 ───────────────────────────────────────────────
const personaText = JSON.parse(fs.readFileSync(PERSONA_SRC, 'utf8'))
const personaIdx = plugins.findIndex((p) => p.id === 'persona')
if (personaIdx < 0) throw new Error('标准模式里没有 persona 行')
plugins[personaIdx] = {
  id: 'persona',
  name: '@deepseek-ai/dsh-persona',
  config: { ...(plugins[personaIdx].config ?? {}), ...personaText },
}
console.log('persona 已替换为课程老师（prefix 长度 ' + String(personaText.prefix?.length ?? 0) + '）')

// ── 3) 组出 patch：整个文档一次性 dump ───────────────────────────────────────
//
// 关键：不要手工拼缩进。js-yaml 的 dump 从列 0 开始输出整篇文档；若只 dump 片段
// 再补缩进，就会把"已经缩进好的内容"再缩一次，第二行以后全部错位（踩过）。
const patch = [
  {
    insert: [
      { id: 'course-vault', name: 'dsh-course-vault' },
      {
        id: 'preset-course',
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'course',
          name: '课程模式',
          description:
            '苏格拉底式教学：AI 讲原理、给规格、拆小步、逐级提示与审查；核心代码由学员自己写，AI 默认不动你的文件。',
          order: 5,
          plugins,
        },
      },
    ],
  },
]

const comment = `# dsh-course-vault 的 profile patch 层（DSH 0.2.0 形态）。
#
# 桌面端用的是 @deepseek-ai/dsh-agent-preset-registry：preset 是**声明式**的，
# 注册表不扫描任何目录。所以「课程模式」必须以一行 @deepseek-ai/dsh-agent-preset
# 声明进来，而不是往 $DSH_HOME/.agent-presets/ 放目录（那是旧版 dsh-agent-presets 的做法）。
#
# 子插件行取自桌面端自带的标准模式定义（dsh-web-app/presets/standard.patch.yml），
# 只把 persona 换成课程老师 —— 保证字段名与当前版本一致、能力不缺。
#
# 本文件由 scripts/gen-patch.mjs 生成，不要手改；要改就改 preset/course/persona.yml。
`
const body = yaml.dump(patch, { schema, lineWidth: -1, noRefs: true, indent: 2 })
const outText = comment + body
fs.writeFileSync(OUT, outText, 'utf8')
console.log('已生成', OUT, '| 字节:', Buffer.byteLength(outText))

// ── 4) 回读校验（用同一方言重新解析整份文件，不通过就直接失败）────────────────
const back = yaml.load(outText, { schema })
const row = back[0].insert.find((r) => r.name === '@deepseek-ai/dsh-agent-preset')
if (!row) throw new Error('回读失败：找不到 preset 定义行')
console.log(
  '回读校验: id=' + row.config.id,
  '| plugins=' + row.config.plugins.length,
  '| order=' + row.config.order,
  '| name=' + row.config.name,
)
const p = row.config.plugins.find((x) => x.id === 'persona')
console.log('persona.prefix 回读长度:', String(p.config.prefix ?? '').length, '| suffix 长度:', String(p.config.suffix ?? '').length)
const groups = row.config.plugins.filter((g) => g.group === true)
console.log('group 行:', groups.map((g) => `${g.id}(${g.config.length})`).join(', '))
const dis = row.config.plugins.filter((x) => x.disabled !== undefined)
console.log('disabled 行:', dis.map((x) => x.id).join(', '))
