# C 积木算法面板

面向本科 C、数据结构与算法课程的本地 Electron 工作台。它把 `main.c` 保持为唯一事实源，同时将源码投影为可自由摆放的节点、可验证的控制连线、代码与运行证据，帮助用户从“看懂一段 C”逐步过渡到“组装、运行和改进算法”。

当前版本为 `v0.1.0-beta.12` 发布候选：默认白底黑字，顶部 Dock 只保留“设置、预设块、Library、面板预览”四个入口；外部 AI、遥测和云同步均未启用。

## 当前实现

### M0–M5：保真 C 底座与本机诊断

- 任意单文件 C17 源码先保真导入，再由 Tree-sitter 投影为语句级积木；CRLF、BOM、注释和无法结构化的原始文本不会被静默丢失。
- 代码与积木双向定位，支持经过旧快照、精确补丁、完整重解析和结构后置条件门禁的受限结构编辑。
- 保守的函数级 CFG、def-use、到达定义、循环/数组事实和直接唯一堆句柄 typestate；finding 明确区分 `certain`、`likely` 与 `hint`。
- 本机 Apple clang 编译运行、静态诊断、ASan/UBSan 与独立 plain `leaks` 检查；renderer 不拥有 Node 或文件系统权限。
- M5 完整验收已于 2026-07-11 通过，历史 M0–M5 单元、架构、金样本、fuzz 和 Electron 回归继续保留为发布门禁。

### M6：自由画布与工业工作台

- 原生 TypeScript + HTML 节点层 + SVG 连线层实现自由画布；节点可自由拖动，画布支持平移、缩放、框选、对齐、复制、删除和撤销。
- 折叠节点保持紧凑，只显示名称、类型、状态和端口。单击节点在画布内打开唯一的非模态详情窗，可编辑代码、查看通俗解释、端口、诊断和运行数据。
- 控制边为可编辑实线，def-use 数据边为只读虚线。普通顺序节点不能任意扇出，只有 `if`、`switch`、循环等具有真实 C 分支语义的节点才能暴露对应控制端口。
- Dashboard 整行单击或按 Enter 直接打开条目；根界面不整体滚动，各功能区独立滚动，主要区域使用可持久化的鼠标/键盘分隔条。
- M5 分析迁入 Worker，并按函数渐进生成 CFG，避免大型源码同步冻结 renderer。

### M7：安全改线、Trace 与运行证据

- 画布位置完全自由，但位置不代表执行顺序。改线先形成 `ConnectionIntent`，只有能生成合法候选 C、精确重解析并通过 CFG 后置条件时才写入 `main.c`。
- 从预设或自定义源码拖入空白处先形成“未接入草稿”；草稿不参与编译或运行。`raw`、宏边界和 partial CFG 节点仍可查看、编译和运行，但拓扑锁定。
- Start/End 映射函数 CFG 边界；Pause/Checkpoint 只控制教学回放，不伪装成改变 C 语义的语句。
- 受限 Trace API 使用临时影子源码插桩，不改项目源码；真实 stdin、args 和 fixture 决定实际路径，画布按事件实时高亮。
- Trace 会绑定源码指纹和一次运行授权，并在取消、源码变化、10,000 条事件或 8 MiB 上限时 fail closed。
- 教学模拟与真实运行严格隔离：模拟可用于解释流程，但不产生真实输出结论，也不会写入性能历史。
- `RunResult` 分开展示编译耗时、墙钟时间、峰值 RSS、峰值进程数、输出字节、执行节点、操作计数和终止原因。
- 真实运行最多保留 100 条；只有同源码指纹、同案例版本和同工具链的数据可直接比较。Benchmark 使用多规模重复运行的中位数和操作计数增长，不生成虚假的“综合效率分数”。

### M8：学习内容与离线导师

- 内置 80 个版本化预设，其中 75 个有源码、5 个是 Start/End/Pause/Checkpoint/Merge 虚拟流程节点；覆盖 C 基础、函数与 I/O、数组字符串、指针内存、主要数据结构和本科常见算法模式。
- 预设使用 `PresetBlockDefinition`，包含类型、端口、放置条件、源码、解释、案例、替代版本和生命周期。项目保留模板版本与源码快照，模板弃用或退休不会破坏既有源码。
- Library 包含 11 个分支、114 个实质条目，覆盖完整软件手册、画布连线、运行诊断、C 语法、标准库、数据结构、算法与复杂度、案例、故障恢复、扩展 API 和新手引导。
- `LocalEvidenceMentor` 只根据当前静态 finding、循环结构、真实路径和运行历史生成可定位提示；排序、搜索、递归、链表、树、图和动态规划案例均由本地确定性 `ScenarioProvider` 提供。
- “AI”在当前 Beta 中只是离线 provider 接口和本地证据提示，不连接外部模型、不上传源码、不自动改写代码。未来网络 provider 必须先在设置页获得明确授权。
- 新手引导按真实界面逐步切换 Dashboard、预设、画布、详情、代码、运行证据、导师和 Library，可随时跳过或重新打开。

### M9：Beta 发布边界

- 开发和 CI 固定 Node 24 LTS、npm 11.11.0，并由 lockfile、架构门禁和 `accept:m9` 验证发布元数据。
- GitHub tag 工作流只为与 `package.json` 版本完全一致的 tag 生成一个 Universal DMG，随后生成并验证 `SHA256SUMS.txt`，最后创建 GitHub pre-release。
- `v0.1.0-beta.12` 是明确的未签名、未公证测试包。稳定版 `v0.1.0` 在 Developer ID、Hardened Runtime、最小 entitlements、公证、staple 和安装态回归全部通过前禁止发布。

## 关键边界

### 源码权威，不是任意图语言

自由画布不是另一套可执行 DSL。节点坐标只影响视图，控制连线只有在当前 C 语法和 CFG 的安全子集内才可提交；不安全的扇出、跨语法边界、歧义锚点和 `raw/partial` 改线会被拒绝。任意导入 C 都能投影和运行，不等于任意 C 都能从图上重连。

### 真实执行与教学模拟隔离

真实路径必须来自实际编译运行和 Trace 证据。只有结构可达且绑定有效输入的目标分支可尝试真实运行，并需由轨迹验证确实经过该分支。无法构造输入时只能教学模拟，界面会明确标记，且不污染真实性能历史。

### 指标不是复杂度证明

单次时间和内存只描述该机器、该输入与该工具链的一次观测。Big-O、实测耗时和内存分别呈现；增长趋势只作为证据，不替代算法证明。

## 本地工作区与 sidecar

应用启动后进入 Dashboard，不会静默载入演示代码。托管条目位于：

```text
~/Documents/C Algorithm Workbench/
├── Projects/<project-id>/
│   ├── entry.json
│   ├── main.c
│   ├── flow-view.json      # 首次保存布局后按需创建
│   ├── scenarios.json      # 项目案例按需创建
│   └── run-history.json    # 真实运行历史按需创建，最多 100 条
├── Sandboxes/<sandbox-id>/
│   └── ...
└── Tests/<test-id>/
    └── ...
```

- `main.c` 始终是程序事实源，并在 300 ms 防抖后由主进程原子保存。
- `flow-view.json` 只保存坐标、视口、草稿、Checkpoint、面板布局和源码指纹；它不保存另一份权威程序图。
- `scenarios.json` 保存项目输入、目标分支、期望输出和规模生成信息；`run-history.json` 保存有上限的真实运行摘要。
- 旧 v1 项目可原样打开，首次保存对应数据时才创建 sidecar。sidecar 版本错误、内容损坏或指纹过期只会重置相应视图/历史，不会改写 `main.c`。
- 临时节点 ID 不直接持久化；恢复使用结构路径、源码指纹和文本锚点，遇到歧义时要求重新定位。
- renderer 只持有不可推导路径的条目 ID；绝对路径解析、文件读写和 revision 检查均留在 Electron 主进程。

## 开发

要求 macOS、Node 24 LTS、npm 11.11.0 和 Apple clang 17.x–21.x。Node 25 以及范围外 clang 不受支持；开始前确认：

```sh
node --version   # v24.x
npm --version    # 11.11.0
```

安装、开发与常用验证：

```sh
npm ci
npm run verify:toolchain
npm run dev
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run accept:m5
npm run accept:m0-m5-regression
npm run accept:m6
npm run accept:m7
npm run accept:m8
npm run accept:m6-m8
npm run accept:m9
```

`accept:m0-m5-regression` 固定执行 runner 金样本、逐字符往返、编辑等价和两套 5000 轮 fuzz；`accept:m6`、`accept:m7`、`accept:m8` 分别验证自由工作台、真实执行和学习扩展；`accept:m6-m8` 会追加生产构建与 Electron 实机回归。`npm run accept:m9` 只离线校验版本、发布元数据、工作流和未签名 Beta 边界，不会联网、创建 GitHub Release 或构建 DMG。完整 M0–M9 专项命令均保留在 `package.json`。

Electron 43 会在依赖安装阶段下载并校验对应平台二进制。离线开发前必须同时准备 npm 缓存与 Electron 二进制缓存，不能只保留 `package-lock.json`。

## 构建与试用未签名 Beta

本地生成 Universal DMG：

```sh
npm run accept:m9
npm run format:check
npm test
npm run accept:m0-m5-regression
npm run accept:m6-m8
npm run test:e2e
npm run dist:mac:beta
```

产物位于 `release/`。GitHub pre-release 会同时提供 DMG 与 `SHA256SUMS.txt`；下载到同一目录后先验证：

```sh
shasum -a 256 --check SHA256SUMS.txt
```

校验通过后挂载 DMG，将应用拖入 Applications。由于 Beta 未签名、未公证，Gatekeeper 可能阻止首次启动：在 Finder 中按住 Control 单击应用，选择“打开”并再次确认；若仍被阻止，可在“系统设置 → 隐私与安全性”中确认该应用后选择“仍要打开”。不要全局关闭 Gatekeeper，也不要在校验失败时继续安装。

## 安全与隐私

应用会在本机编译并运行用户选择的 C 程序。未知 C 文件应按可执行代码对待；资源限制与 macOS Seatbelt 最佳努力隔离不能把任意原生代码变成安全文档。关键隔离能力不可用时，runner 会 fail closed；只有 Electron main 针对当前精确请求获得原生确认后，才可签发不可复用的 trusted-only 授权。

当前 Beta 无遥测、账户、广告、云同步或联网 AI，不上传源码、Trace 或运行历史。完整说明见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)。

## 架构决策

- [ADR-0001：版本化工作台模块](./docs/architecture/decisions/0001-versioned-workbench-modules.md)
- [ADR-0002：Documents 托管工作区](./docs/architecture/decisions/0002-managed-documents-workspace.md)
- [ADR-0003：源码权威的自由流程投影](./docs/architecture/decisions/0003-source-authoritative-flow-projection.md)
- [ADR-0004：有界影子源码 Trace](./docs/architecture/decisions/0004-bounded-shadow-trace.md)
- [ADR-0005：性能证据与复杂度结论分离](./docs/architecture/decisions/0005-evidence-separated-efficiency.md)

## 不可协商原则

> 宁可显示“无法确定，保留原始 C”，也不丢字符、不静默改语义、不把模拟当实测、不把提示当证明。

完整工程契约、历史里程碑与验收条件见 [CLAUDE.md](./CLAUDE.md)。
