# dsh-course-vault

把**一次课程**在几台电脑之间搬来搬去——课程内容、会话记忆、学习模式，一个插件全包。

为「在家里台式机上学习，突然出差一个月切到笔记本，回来再迁回台式机」这种场景设计。

## 它解决什么

| 需求 | 现状 | 本插件 |
|---|---|---|
| 课程内容（大纲/讲义/手搓代码/测验）跨机 | git 或手动拷 | **一键完整包**（内容 + 会话打成一个 `.dsvault`） |
| 会话记录跨机 | DSH 只有单会话 `/export`，按不了项目、还原不了 | **按工作区收拢 + 一键导入还原进会话列表** |
| 目标机路径不同 | — | **路径映射**：自动重写会话 header 的 `cwd` |
| 换个电脑还要「像老师一样教」 | 每次手动贴教师提示词 | **课程模式**：与标准/PTC 平级的第 5 个 agent preset |

## 两条纪律（比功能更重要）

1. **进度证据走 git，会话记忆走 `.dsvault`。**
   `03_LEARNING_STATE.md`、Notebook、你手搓的代码是**真正的进度证据**——用 git 搬。
   `.dsvault` 只承载会话记录，它让模型「记得上次聊过什么」。
   **跨机后模型知道进度，靠的是学习档案被 git 带过去，不是靠会话包。**

2. **本插件不碰课程文件，也不标记进度。**
   导入只写 `$DSH_HOME/sessions/` 与课程内容落点；不改你的 `.md`/`.ipynb`/`.py`（除非你显式覆盖）。

> ⚠️ **别这样搬**：在笔记本上恢复包 → 学一个月 → 把包搬回台式机。
> 台式机的课程文件夹还停在出发那天，搬回去会分叉。
> 回去的正确动作是 **`git pull` 拉文本证据**，会话包单独反向导一次。

## 安装

```bash
# 预构建（推荐，无需构建授权）
dsh plugin --profile default add dsh-course-vault

# 或从 GitHub 源码（pnpm 会拦截构建脚本，按提示加 allowBuilds 后重试）
dsh plugin --profile default add github:Guybod/dsh-course-vault
```

装完会做两件事：

1. 在 `ctx.webServer` 上挂 `/dsh-course` 前缀通道（第三方插件唯一稳定的直连方式）；
2. 把**课程模式** preset 同步到 `$DSH_HOME/.agent-presets/course/`（缺失或过期才写）。

### 换机时若 `dsh plugin` 报 `'pnpm' is not recognized`

`dsh plugin` 会把命令转发给 pnpm，所以机器上得有 pnpm 在 PATH 里。DSH 桌面端自带一份运行时，
但**只提供 `pnpm.mjs`，没有 `.cmd` 外壳**，命令行调用时会报找不到 pnpm。建一个 shim 即可（真实踩过）：

```powershell
$shim = "$env:USERPROFILE\.dsh\shim"
New-Item -ItemType Directory -Path $shim -Force | Out-Null
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
Set-Content "$shim\pnpm.cmd" "@echo off`r`n`"$node`" `"$pnpm`" %*" -Encoding ASCII
$env:PATH = "$shim;$env:PATH"   # 之后 dsh plugin 就能用
```

## 用法

### 一键完整包（换电脑、备份）

```js
import { exportWorkspaceSessions } from 'dsh-course-vault/src/core/export.js'

// 导出：课程内容 + 全部会话，一个文件
await exportWorkspaceSessions({
  dshHome: 'C:\\Users\\you\\.dsh',
  workspace: 'D:\\code\\LLM_VLA_Handwritten_Course',   // 会话归属的工作区
  contentRoot: 'D:\\code\\LLM_VLA_Handwritten_Course', // 要打包的课程文件夹
  sessionsDir: 'D:\\code\\LLM_VLA_Handwritten_Course\\sessions',
})
// → sessions/LLM_VLA_Handwritten_Course-20261001.dsvault + exported.json 账本
```

```js
import { importFullVault } from 'dsh-course-vault/src/core/import.js'

// 先看差异（不写盘）
const dry = await importFullVault({
  vaultPath: '...dsvault',
  dshHome: HOME,
  contentTarget: 'D:\\code\\LLM_VLA_Handwritten_Course', // 内容落点
  targetCwd: 'D:\\code\\LLM_VLA_Handwritten_Course',     // 会话映射到的工作区
})

// 确认后落盘
await importFullVault({ ...same, apply: true })
```

只搬会话（日常来回搬，秒级）：

```js
await exportWorkspaceSessions({ dshHome, workspace, sessionsDir }) // 不给 contentRoot
```

### 通过 RPC 通道（UI / 脚本）

`POST /dsh-course/<endpoint>`，遵循官方 client-request 信封：

| 端点 | 作用 |
|---|---|
| `runtime/get` | 版本、DSH_HOME、profile |
| `preset/status` / `preset/sync` | 课程模式是否就位 / 手动同步 |
| `workspace/list` | 会话根下所有工作区 |
| `vault/list` / `vault/inspect` | 列出 / 查看并逐项校验 `.dsvault` |
| `course/card` | 读课程卡，如实报告关键文件存在性 |
| `course/export` | 一键导出（`sessionsOnly: true` 只导会话） |
| `course/import-plan` | 只看差异 |
| `course/import` | 一键导入（必须 `apply: true`） |

### 课程模式

装好后**新建会话**，在模式选择器里选「课程模式」。

- 它是 `standard` 的完整副本，只改三处：persona 换任课老师、追加 `course-tutor` 技能、其余工具能力不变；
- 教学规则：先读课程自己的 `01_TEACHER_PROMPT.md` 与 `03_LEARNING_STATE.md`；每轮只讲一个概念、只给一项小任务；
  卡住时按 **H0→H1→H2→H3** 逐级提示，一次只升一级；
- **默认不代写**：核心实现要你自己写，代码片段给在对话里；**默认不用写文件的工具改你的学习代码**；
  你若坚持要它写，它会写，但会先说一句「自己手写一遍效果更好」；
- 只有你说「这一步给出参考代码」时才给某一段，并安排一道不同输入/结构的独立复写。

> 约束：DSH 的模式**只能在尚未产出内容的空白会话上切换**，已有对话切不了；改默认值只影响之后新建的会话。
> 想让新课默认走课程模式：设置里把 `agent-presets.default` 改成 `course`。

## 包结构

`.dsvault` 是标准 ZIP，7-Zip / 资源管理器可直接打开：

```
.dsvault/manifest.json      清单：内容清单 + 会话清单，逐文件 sha256
.dsvault/content/**          课程文件夹（outline / lessons / projects / assessments / 学习档案…）
.dsvault/sessions/<id>/session.v4.jsonl.zstd
```

导入的内容合并策略：逐文件比 sha256，分「新增 / 相同 / 冲突」；
**冲突默认不覆盖**，列出来让你决定（`replace: true` 才覆盖）。会话永远不动你本机已有的。

## 实现要点

- **多 frame 解压**：DSH 把每个持久化批次写成独立、带 checksum 的 zstd frame 并拼接。
  Node 内置 API 解不开（同步只解第一个 frame，流式报 `ZSTD_error_prefix_unknown`），
  因此按 frame 魔数切分后逐 frame 解压（真实会话 322 个 frame 零失败）。
- **只重写 header frame**：跨机路径映射只重压第一个 frame（header），**事件 frame 按原字节拷贝**。
  所以迁移是无损的，也不会碰到 DSH 的打包分片重编码。
- **压缩端对齐 checksum**：DSH 写日志用 `ZSTD_c_checksumFlag`，新压的 header frame 必须一致。
- **目录算法与 DSH 逐字节一致**：项目目录 `projectKey(cwd)`、会话目录 `encodeSegment(id)`；
  测试用本机真实目录名做锚点断言，规则漂移会立刻失败。
- **零第三方依赖**：自带 ZIP 写入器（store 法）+ `node:zlib`，跨机安装不需要联网取依赖。
- **RPC 通道不用 `connection.rpc.handle`**：它把 owner 固定成 connection 插件自身上下文，
  第三方插件调用会拿到 `undefined` 并让 fiber 失败；改用自建 `webServer` 前缀路由。

## 测试

```bash
node test/run-all.js
```

覆盖：目录算法与 DSH 一致、真实会话解码、header 重写后其余 frame 字节零改动、篡改检测、
ZIP 可被 Windows 自带解压、导出→校验→导入→幂等、坏包拒装、
一键完整包往返（含冲突保护）、preset 同步幂等、host 层加载与端点参数校验。

> Windows 沙箱下不要用 `node --test test/`（需要 spawn 子进程，会命中 `spawn EPERM` 边界），
> 用 `test/run-all.js`（进程内 import）。

## 已知限制

- 尚未提供图形界面：目前通过 RPC 通道 / Node API 使用；UI 挂在既有插槽上的计划见下。
- 课程模式 preset 依赖 `$DSH_HOME/.agent-presets`；若该目录是被整合包换指的 junction，
  切换 profile 后可能丢失——重新 `preset/sync` 即可恢复（插件启动时也会自检）。
- `.dsvault` 是二进制，建议加入课程仓库的 `.gitignore`，会话记录不要进 git。
- 导出**当前正在对话的会话**时，磁盘上只有"最近一次 flush 的前缀"；已在写入的会话会被冻结在
  导出那一刻（源文件随后继续增长），这是预期行为，不是损坏。

## 实测记录（v0.1.0）

在 `dsh-base + dsh-web-app` 的最小 web profile 上真启动验证过：

| 验证项 | 结果 |
|---|---|
| 插件加载（`--dump-config` 出现 `# == dsh-course-vault` 层） | ✅ |
| 真启动挂上 `/dsh-course` 通道（`GET /dsh-course/health` → 200） | ✅ |
| `preset/status` → 课程模式 `installed: true, upToDate: true` | ✅ |
| 插件自动把课程模式同步到 `$DSH_HOME/.agent-presets/course/` | ✅ |
| `course/card` 读真实课程卡（`01_TEACHER_PROMPT.md` 等三份文件均 present） | ✅ |
| 一键完整包：146 个课程文件 + 1 条 1.7 MB 真实会话 → 3.4 MB 包，sha256 逐项通过 | ✅ |
| 导入到另一路径：内容 146 文件全落位、会话 header 改写为新 cwd、`id`/`agentPreset` 保留 | ✅ |
| 幂等：同包再导 → 会话全 skip、内容全 same，不覆盖、不重复 | ✅ |
| 导入后 DSH 能识别：`workspace/list` 出现新路径（1 条会话） | ✅ |

> 仍未验证的一条：**导入的会话在 GUI 会话列表里的最终呈现需要重启一次桌面端**才能确认
> （CLI 启动的验证实例已经能看到该 workspace，但桌面 GUI 的列表渲染未实测）。

## 踩过的坑（开发时真实遇到，写下来免得再犯）

1. **`inject` 会拖垮别人的 profile**：把 `webServer` / `profileContext` 写进 `inject` 后，
   没有 `dsh-web-app` 的最小 profile 会因 `assertEntriesActivated` **整体启动失败**。
   正确做法是 `inject = []` + 全部走 `ctx.get()`。
2. **未 inject 的服务不能用属性访问，可选链也挡不住**：`ctx?.connection` / `ctx?.logger` 会抛
   `cannot get property "X" without inject`，而 webserver 的 `handle()` 把路由抛错统一包成
   **400 空响应**——症状是"通道没反应"，不是 500。定位方法是往临时日志写文件。
3. **PowerShell 往返会毁掉 UTF-8 源文件**：用 `Get-Content -Raw` + `Set-Content` 批改中文源文件，
   读取按 ANSI 解码、写回再编码，**中文全乱码、反引号丢失、语法直接坏掉**。改代码只用 edit 工具。

## 路线

- [x] 会话按工作区收拢 / 一键导出 / 一键导入 / 路径映射
- [x] 一键完整包（课程内容 + 会话）
- [x] 课程模式 preset（含 `course-tutor` 技能）
- [x] host 入口 + `/dsh-course` RPC 通道
- [ ] 真实服务上验证「导入后进入会话列表」
- [ ] UI：`sidebar.workspaces`（课程包列表）、`conversation.session.header.utilities`（课程包按钮）、设置页工作台
- [ ] 课程卡 `course.config.yaml` 的完整 schema 与进度账本工具

## License

MIT
