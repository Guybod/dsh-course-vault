# 暂停使用的客户端半包（不要发布）

这里是被摘下来的「会话头部按钮」客户端代码，**当前不参与加载**。

## 为什么摘掉

加上客户端半包（`package.json` 的 `dsh.client` + `exports["./client"]`）后，DSH 启动失败，
自愈机制把该 bundle 从 profile 里剔除了，连带着把另外几个 bundle 也一起清掉
（用户看到的是"直接不能启动了"）。因为拿不到启动期的日志，**根因还没有确定**。

## 里面有什么

| 文件 | 说明 |
|---|---|
| `lib/client.js` | 浏览器侧 UI：`window.__ModuleLoader__.load({...})`，注册三个按钮到 `conversation.session.header.utilities` |
| `client.js` | 原来的 `src/client.js`（`exports["./client"]` 的宿主侧登记入口） |

## 恢复它之前必须先做的事

1. **先能拿到启动日志**。桌面端启动失败时目前无处可见（`~/.dsh/profiles/*/.plugin-manager/logs`
   只有 pnpm/git 的日志，没有 loader 的）。在拿到真实错误之前不要再合回去——
   我们已经用一次"启动不了"换来的教训是：**不要盲改启动期配置**。
2. 逐个变量验证，别一次全上：
   - 只加 `dsh.client` 而不改 `exports`（看是否只是声明就失败）
   - 只加 `exports["./client"]` 指向一个极简模块（看是否是模块解析问题）
   - 再放真正的 UI 代码
3. 每个实验都留一条退路：profile 的 `package.json`（bundles 列表）留备份，
   启动失败时把 bundles 收敛回 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 即可恢复。

## 已知可疑点（按可能性排序）

1. `dsh.client.inject` 里列的是**包名**，但那几个包在桌面端 asar 里的存在形式需要核实；
   解析不到可能导致条目激活失败。
2. 客户端 bundle 的装配时机 / `immediately: true` 的语义没核。
3. `factory(require)` 里 `require('react')` 是否可用未核实（模板说浏览器模块表提供）。
4. `ctx.slots.inject(...)` + `ctx.slots.register(...)` 的具体签名只照模板抄过，没在真机验证。

## 现在如何用这些能力

用命令行脚本，功能完全一样且已验证：

```powershell
node tools/export.mjs "D:\code\LLM_VLA_Handwritten_Course"
node tools/import.mjs "<包.dsvault>" --to "D:\code\LLM_VLA_Handwritten_Course" --apply
```
