# C 积木算法面板

面向墨尔本大学 `COMP10002` 与后续算法课程的本地学习软件。用户可以导入 C17 单文件源码，将其无损投影为语法积木，在代码与积木之间同步定位，并逐步扩展到确定性程序分析、算法识别和 AI 导师。

## 当前状态

**M2：面板与双向高亮已完成。** 2026-07-10 执行 `npm run accept:m2`，M0–M2 全量门禁通过：163 个单元/集成测试、20 个金样本、5 个真实压力样本、2000 例变异 fuzz、72 个 M2 专项断言及 21 个 Electron E2E。当前版本是可直接启动的本地 Electron 工作台；按 M2 边界保持只读，不支持积木编辑、算法识别或 AI。

已建立：

- Electron + Vite + TypeScript 本地应用骨架
- 原生文件选择、磁盘文件拖放与粘贴三种 C 源码导入入口
- 紧凑的三栏编辑器外壳、解释/运行检查器标签与正式 macOS App 图标
- 语句级积木树、只读 CodeMirror C 代码区与确定性解释面板
- 积木 ↔ 代码双向定位，以及变量声明/使用点联动高亮
- 局部、文件、用户宏和 C 标准库三张内置表组成的符号解析链
- R11 可疑解析提示，以及无法可靠结构化时的原始 C 降级
- 能力探测、编译、运行、诊断、stdout/stderr 和终止状态面板
- 精确锁定的工具链与 lockfile 验证
- 20 个正常 C 金样本与 5 个资源/故障压力样本
- 逐字节 I/O、ASan + UBSan 与独立 `leaks` 双闸验证器
- macOS Seatbelt 最佳努力隔离、资源限制、进程组清理与原生信任确认
- `SourceDoc` / `Block` 不可变模型，以 UTF-16 半开区间保存语句级 `syntax` 与保真 `raw`
- 显式注释节点及确定性吸附归属，可从 Tree-sitter `ERROR` 中挖出仍完整的函数
- 两枚精确锁定的 Tree-sitter WASM 资产，以及真实 Electron renderer 解析冒烟
- 163 个单元/集成测试、架构边界检查、21 个真实 Electron E2E 与可复现的变异 fuzz

## 开发命令

```sh
npm ci
npm run verify:toolchain
npm run dev
npm test
npm run build
npm run verify:samples
npm run verify:roundtrip
npm run fuzz -- --runs 2000
npm run accept:m0
npm run accept:m1
npm run accept:m2
```

Electron 43 不再在 `npm ci` 的 `postinstall` 阶段下载原生二进制；首次执行 Electron 命令时会按需下载并校验。离线开发前应先在有网络或已有 Electron 缓存的环境启动一次。

## 安全边界

Electron renderer 不拥有 Node 或文件系统权限，只能经 preload 调用具名 IPC。C 编译与运行必须经过能力探测、输入校验、临时目录、进程组回收及资源限制。

macOS `sandbox-exec`/Seatbelt 是已弃用的最佳努力隔离机制，不等于 hostile-code 级沙箱。关键隔离能力不可用时，runner 必须 fail closed；只有 Electron main 针对当前请求显示原生确认框并获得用户确认后，才会为这一请求签发不可复用的内部授权。renderer 不能自行声明“已确认”。

## 不可协商原则

> 宁可显示“无法确定，保留原始 C”，也不丢字符、不静默改语义、不误贴算法标签。

完整工程契约、里程碑与验收条件见 [CLAUDE.md](./CLAUDE.md)。
