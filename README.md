# C 积木算法面板

面向墨尔本大学 `COMP10002` 与后续算法课程的本地学习软件。用户可以导入 C17 单文件源码，将其无损投影为语法积木，在代码与积木之间同步定位，并逐步扩展到确定性程序分析、算法识别和 AI 导师。

## 当前状态

**M3：积木编辑闭环已完成。** 2026-07-10 执行 `npm run accept:m3`，M0–M3 全量门禁通过：369 个单元/集成测试、20 个金样本、5 个真实压力样本、2000 例变异 fuzz、72 个 M2 专项断言、97 个 M3b 专项断言及 36 个 Electron E2E。局部重命名等价矩阵覆盖 118 个目标：92 个安全目标完成重新编译与 I/O 逐字节对比，26 个目标因遮蔽风险明确拒绝。当前版本是可直接启动的本地 Electron 工作台；尚不包含算法识别、算法图或 AI。

**M4：降级健壮化与组装学习工作台已完成。** 2026-07-11 执行 `npm run accept:m4`，M0–M4 聚合门禁全绿：462 个单元/集成测试、20 个金样本、5 个压力样本、2000 例变异 fuzz、5000 例课程 C 生成式 fuzz、56 个全量 Electron E2E，以及 16 份困难语料的严格投影与 UI 导入回归。当前版本包含分阶段预制积木、真实拖放插槽、自定义积木生命周期和新手问答引导；尚不包含 M5 之后的 CFG、数据流、算法识别与 AI。

已建立：

- Electron + Vite + TypeScript 本地应用骨架
- 原生文件选择、磁盘文件拖放与粘贴三种 C 源码导入入口
- 深色/浅色可切换并持久化的工业风三栏工作台，以及正式 macOS App 图标
- 语句级积木树、可直接编辑且保留 CRLF/BOM 的 CodeMirror C 代码区与确定性解释面板
- 积木 ↔ 代码双向定位，以及变量声明/使用点联动高亮
- 改字面量、换二元运算符、编辑 `for` 三段与 `if` 条件的结构化表单
- 运算符优先级安全括号化、最小补丁预览、显式 diff 确认与精确 undo/redo
- 整行语句插入/删除、同父相邻语句上移/下移与受限真实拖拽
- 函数内局部变量保守重命名；字段、标签、字符串、注释、宏与不确定绑定不会被误改
- 120 ms 源码重解析防抖；大范围语法恢复时保留上一棵稳定积木树并暂停反向编辑
- 所有 M3b 操作统一经过旧快照校验、精确补丁、完整重解析、ERROR/MISSING 硬门禁、结构后置条件与 diff 确认
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
- 版本化本地工作台模块注册表、动态检查器入口与算法元素描述契约
- 顶部 Dock、分阶段预制积木库、真实前后插槽组装与代码 diff 确认
- 自定义积木的创建、弃用、恢复与退休；退休不会删除已经生成的 C 源码
- 可重复打开的确定性新手问答引导，以及面向初学者的预制积木入口
- 16 份 M4 困难 C 语料、严格投影 oracle 与课程 C 生成器
- TypeScript 源码 + 编译产物双层架构门禁，阻止类型导入绕过模块边界
- 462 个单元/集成测试、56 个真实 Electron E2E 与可复现的双层 fuzz

当前扩展层是后续算法工具的**第一阶段地基**：它已经提供模块、检查器、命令和算法元素的稳定发现契约，但没有第三方插件执行、算法图、元素持久化或完整的算法创建/改进工作流。后者将在 M5/M6 的确定性分析模型落地后建模，避免现在固化错误抽象。架构决策见 [ADR-0001](./docs/architecture/decisions/0001-versioned-workbench-modules.md)。

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
npm run accept:m3a
npm run verify:m3b
npm run verify:edit-equiv
npm run test:e2e:m3b
npm run accept:m3
npm run verify:m4
node scripts/generator-fuzz.mjs --runs 5000
npm run test:e2e:m4
npm run accept:m4
```

### M4 使用与验收

- `npm run verify:m4`：运行 16 份固定语料、历史回归和默认 500 例课程 C 生成式性质测试。
- `node scripts/generator-fuzz.mjs --runs 5000`：执行深度生成式检查；失败时输出 seed、shrink path，并可写入本地回归样本。
- `npm run test:e2e:m4`：生产构建后运行积木组装 E2E，并逐份通过可见“打开 C 文件”入口导入 16 份 M4 语料，检查解析状态、无损往返、积木交互与 renderer 崩溃。
- `npm run accept:m4`：依次执行 M3 全量回归、M4 专项测试、5000 例深度生成 fuzz 和 M4 Electron E2E；任一阶段失败即停止并返回非零状态。

Electron 43 不再在 `npm ci` 的 `postinstall` 阶段下载原生二进制；首次执行 Electron 命令时会按需下载并校验。离线开发前应先在有网络或已有 Electron 缓存的环境启动一次。

## 安全边界

Electron renderer 不拥有 Node 或文件系统权限，只能经 preload 调用具名 IPC。C 编译与运行必须经过能力探测、输入校验、临时目录、进程组回收及资源限制。

macOS `sandbox-exec`/Seatbelt 是已弃用的最佳努力隔离机制，不等于 hostile-code 级沙箱。关键隔离能力不可用时，runner 必须 fail closed；只有 Electron main 针对当前请求显示原生确认框并获得用户确认后，才会为这一请求签发不可复用的内部授权。renderer 不能自行声明“已确认”。

## 不可协商原则

> 宁可显示“无法确定，保留原始 C”，也不丢字符、不静默改语义、不误贴算法标签。

完整工程契约、里程碑与验收条件见 [CLAUDE.md](./CLAUDE.md)。
