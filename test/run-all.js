/**
 * 测试入口：逐个 import 各测试文件。
 *
 * 为什么不用 `node --test test/`：DSH 的 Windows 沙箱下 `node --test` 需要 spawn
 * 子进程并通过管道收集输出，会命中沙箱的 `spawn EPERM` 边界。直接在当前进程里
 * import 测试文件，走的是 Node 内置 test runner 的进程内模式，完全避开子进程。
 */

import '../test/codec.test.js'
import '../test/zip.test.js'
import '../test/export.test.js'
import '../test/import.test.js'
import '../test/full.test.js'
import '../test/preset.test.js'
import '../test/host.test.js'
