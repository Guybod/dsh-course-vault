/**
 * 客户端半包的宿主侧登记入口（`exports["./client"]` 指向 `lib/client.js`）。
 *
 * 真正的渲染全在 `lib/client.js`（浏览器侧、`window.__ModuleLoader__` 格式）。
 * 这个文件存在的意义是让 `./client` 这个导出真的能被解析——插件契约要求声明过的
 * 导出路径必须存在可加载的模块。
 */
export const name = 'dsh-course-vault-client'
