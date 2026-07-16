# AlgoLatch

**AlgoLatch** 是一个面向本科 C、数据结构与算法学习的本地桌面工作台。
它把真实 `main.c` 投影为可拖动、可连线的流程画布，同时保留源码编辑、真实
运行、Trace、性能证据、静态分析和课程指导。

它不是 Scratch 的 C 语言复刻，也不会维护一份与源码竞争的隐藏图模型。
`main.c` 始终是唯一可执行事实源；画布只负责让程序结构更容易看见、组装和
验证。

## 下载

| 平台                          | 当前状态                   | 下载                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon / Intel | `v0.0.2-preview.2`，未签名 | [Universal DMG](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/AlgoLatch-0.0.2-unsigned-universal.dmg) · [SHA-256](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/SHA256SUMS.txt) |
| Windows 10/11 · x64           | `v0.0.2-preview.2`，未签名 | [下载 EXE](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/AlgoLatch-Setup-0.0.2-unsigned-x64.exe) · [SHA-256](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/SHA256SUMS.txt)      |

[下载与安装包状态](./DOWNLOADS.md) ·
[查看所有版本](https://github.com/Ice-teapop/algolatch/releases) ·
[v0.0.2 说明](./docs/releases/v0.0.2.md) ·
[当前架构](./docs/architecture/README.md) · [隐私](./PRIVACY.md) ·
[安全](./SECURITY.md) · [Code signing policy](./CODE_SIGNING_POLICY.md)

> GitHub 自动显示的 **Source code** 压缩包不是安装器。`v0.0.2-preview.2`
> 同时提供 macOS 与 Windows 安装包，但两者都是未签名先行版，不是正式稳定
> 版。macOS 可能触发 Gatekeeper，Windows 可能显示未知发布者或 SmartScreen
> 提示；请先核对同一 Release 中的 SHA-256 清单。

Windows 正式版本计划使用 SignPath Foundation 完成来源可验证的代码签名：
**Free code signing provided by SignPath.io, certificate by SignPath
Foundation.** 申请目前仍在审核准备阶段；现有下载不宣称具有该签名。完整
边界见 [Code signing policy](./CODE_SIGNING_POLICY.md)。

## 为什么做这个工具

初学算法时，最难的通常不是记住一段代码，而是同时理解四件事：数据如何
变化、控制流为什么走这条路径、代码修改是否改变语义，以及所谓“更快”有
什么证据。

本项目把这四件事放进同一个工作流：

1. 新建项目，或导入一个 UTF-8 单文件 C 程序。
2. 从预设拖入积木，或直接编辑 C 源码。
3. 在自由画布中查看结构、移动节点并连接兼容端口。
4. 只有候选源码能够完整重解析并满足 CFG 后置条件，语义连线才会写回
   `main.c`。
5. 使用真实输入运行、Trace、诊断和 Benchmark，再根据可追溯证据改进算法。

## 核心能力

### 源码权威的自由画布

- 在 512 KiB、UTF-8 和本地文件安全边界内导入单文件 C 源码；保留 BOM、
  CRLF、注释和无法可靠结构化的原始文本。
- 节点支持自由定位、平移、缩放、框选、对齐、复制、删除和撤销。
- 单击选择节点，双击或按 Enter 打开详情；代码与画布可以双向定位。
- 连线可以从兼容端口的任一端开始，最终规范化为 `output → input`。
- `raw`、宏边界和 partial CFG 仍可查看、编译和运行，但危险拓扑编辑会
  fail closed。

### 真实运行与证据

- macOS 使用受验证的 Apple clang；Windows 10/11 x64 使用随安装包提供、
  摘要锁定的 llvm-mingw。两端都显示编译诊断、stdout、stderr、退出原因、
  耗时、峰值 RSS、输出字节和进程数等数据。
- Trace 通过临时影子源码插桩，不修改项目源码；事件绑定源码指纹、当前窗口
  和单次运行授权。
- ASan/UBSan 与独立 `leaks` 检查用于发现部分内存问题。
- Benchmark 使用多个输入规模和重复样本的中位数；实测时间、操作次数和
  Big-O 结论保持分离。
- 教学模拟不会写入真实运行历史，也不能冒充真实输出或性能结论。

### 学习、设计与分析

- 80 个版本化预设，其中包括 75 个源码积木和 5 个虚拟流程节点。
- 114 个 Library 词条，覆盖 C 语法、标准库、数据结构、算法、复杂度、案例
  和工作台操作。
- 第一课“扫描求最大值”使用独立沙箱和真实任务证据，训练运行、Trace、
  补全、图表阅读、调试和迁移。
- 保守静态分析提供函数级 CFG、def-use、到达定义、循环、数组和直接唯一
  堆句柄 typestate 事实。
- 本地证据提示不需要联网，并明确区分确定事实、可能问题和启发式建议。

### 可选的 AI 助手

用户可自备 API 密钥连接 OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、
智谱 GLM、Kimi 中国区或 Kimi 国际区。

- AI 默认关闭；应用不会自动选择厂商、试钥或切换模型。
- 密钥由 Electron `safeStorage` 使用操作系统能力加密。renderer 只能知道
  厂商、模型和是否存在凭据。
- 默认上下文只包含当前函数和有限的诊断、控制流、运行及对话证据；不发送
  文件路径、stdin 或程序参数。
- AI 修改源码的权限默认关闭。开启后，模型只能提交候选替换；应用仍会检查
  revision、源码指纹、精确 diff、重解析、无损往返和 CFG 后置条件。
- 每个托管工作区对应一个本地 AI Project，可保存多批对话；删除对话数据
  不会影响 `main.c`。

应用不包含遥测、广告、账户或云同步。联网请求只会在用户配置并主动调用
AI 后发送到所选厂商的官方白名单主机。

## 快速开始

1. 打开应用，在 Dashboard 选择“开始第一课”或新建 Project、Sandbox、Test。
2. 进入工作区后，从左侧预设区拖入积木，或在右侧直接编辑 C 代码。
3. 在画布中拖动节点。端口发亮时松开以提交候选连线。
4. 在画布顶部选择输入并点击“运行”。首次执行原生代码时阅读并确认信任
   提示。
5. 使用底部的运行、指标和本地检查；需要完整比较时进入顶部“分析”界面。
6. 双击节点查看通俗解释、端口、诊断和运行证据。

托管项目自动保存在用户 Documents：

```text
~/Documents/C Algorithm Workbench/
├── Projects/<project-id>/
├── Sandboxes/<sandbox-id>/
└── Tests/<test-id>/
```

Windows 通常对应
`%USERPROFILE%\Documents\C Algorithm Workbench\`，内部目录结构相同。

每个条目包含 `entry.json` 和 `main.c`。按需创建的 `flow-view.json`、
`scenarios.json`、`run-history.json`、`tutorial-progress.json` 和
`ai-project.json` 只保存辅助状态。损坏、过期或未知版本的辅助文件可以被
忽略或重置，但不能据此改写源码。

## 安装

### macOS 先行版

1. 在顶部下载表中下载 `v0.0.2-preview.2` Universal DMG 和对应的
   `SHA256SUMS.txt`。
2. 在下载目录运行：

   ```sh
   shasum -a 256 --check SHA256SUMS.txt
   ```

3. 校验成功后打开 DMG，把 **AlgoLatch** 拖入 **Applications**。
4. 如果 Gatekeeper 阻止首次启动，在 Finder 中按住 Control 单击应用，选择
   **打开**并再次确认。
5. 如果仍被阻止，在 **系统设置 → 隐私与安全性** 中确认来源后选择
   **仍要打开**。

该 Preview 使用完整 ad-hoc 签名，但没有 Apple Developer ID 与公证。校验失败
时不要继续安装，也不要全局关闭 Gatekeeper。未来的 macOS 正式包
仍要求 Developer ID、Hardened Runtime、固定最小 entitlements、Apple 公证、
staple、quarantine 后 Gatekeeper 检查和安装态回归全部通过。该计划不会阻塞
Windows 正式包。

如果电脑中仍保留旧的 `C 积木算法面板.app`，确认 AlgoLatch 能看到原项目后
可手动删除旧 app；安装器不会删除项目或设置。

### Windows 先行版与签名版本

Windows 10/11 x64 先行版已经公开：

1. 从顶部下载表下载
   `AlgoLatch-Setup-0.0.2-unsigned-x64.exe` 和 `SHA256SUMS.txt`。
2. 校验 SHA-256 后双击安装器。NSIS 使用 one-click per-user 安装和
   `asInvoker`，不要求管理员权限。
3. 安装完成后直接打开 AlgoLatch。C 编译器已经包含在安装包中，不需要另装
   Visual Studio、LLVM 或修改 `PATH`。

这个 Preview 没有 Authenticode 签名，Windows 会显示未知发布者并可能触发
SmartScreen；仅从本仓库 Release 下载并先核对 SHA-256。卸载 AlgoLatch 不会
删除 Documents 中的项目。未来正式包即使具有有效 Authenticode，新签名证书
或较少下载量仍可能暂时触发 SmartScreen 信誉提示。

Windows x64 Preview 已在 GitHub Actions 中通过构建、安装、启动、创建项目、
编译运行和卸载回归。Windows 正式包可在
Authenticode 签名、签名校验和 Windows 安装态门禁通过后独立发布，不等待
Developer ID、Apple 公证或任何 macOS 发布任务。

## 架构原则

项目是一个本地模块化 Electron 单体：

- `src/core/` 负责 C 解析、无损投影和受控文本补丁。
- `src/analysis/` 只读消费程序事实并生成保守分析。
- `src/flow/` 只描述流程投影、视图状态和连接意图。
- `src/app/` 协调源码、画布、分析、课程和运行证据。
- `electron/preload/` 暴露窄、具名且经过验证的 IPC。
- `electron/main/` 独占文件系统、平台工具链、原生进程、Trace、AI 网络和
  凭据能力。Windows 原生程序运行在受资源约束的 Job Object 中，但该机制不
  提供文件系统或网络隔离。

依赖图禁止 renderer 导入 Electron、主进程导入 renderer、flow 导入写路径，
并拒绝循环依赖。完整进程边界、数据所有权、写入路径和扩展点见
[当前架构](./docs/architecture/README.md)；已接受的决策见
[ADR 索引](./docs/architecture/decisions/README.md)。

## 本地开发

要求 Node 24 LTS 与 npm 11.11.0。macOS 开发使用 Apple clang 17.x–21.x；
Windows 发布构建在 Windows x64 上下载并校验锁定的 llvm-mingw，无需依赖
开发机 `PATH` 中的编译器。

```sh
npm ci
npm run verify:toolchain
npm run dev
```

提交前至少运行与改动相关的检查：

```sh
npm run typecheck
npm run format:check
npm test
npm run build
```

完整回归和发布命令见 [Contributing](./CONTRIBUTING.md)。Windows 正式构建
使用 `npm run dist:win`，只检查 Windows Authenticode 与安装态门禁。macOS
正式构建使用 `npm run dist:mac`，并继续在缺少 Developer ID 或公证凭据时
失败；当前 macOS 测试使用 `npm run dist:mac:beta`。Windows 未签名验证使用
`npm run dist:win:beta`。所有未签名包都使用独立输出目录和文件名。

## 版本与边界

当前源码版本为 `0.0.2`，macOS 与 Windows 已通过未签名的
`v0.0.2-preview.2` 同步提供；正式 `v0.0.2` 尚未发布。每个平台只有在自己的
签名与安装态门禁通过后才能成为正式资产。
`v0.0.1` 是版本线重置后的首个公开正式 Release。历史
`v0.1.0-beta.1–12` 是开发快照，不是从更高版本降级到 `v0.0.1`。完整功能
变化、迁移和已知限制见 [CHANGELOG](./CHANGELOG.md)、
[v0.0.2 说明](./docs/releases/v0.0.2.md) 与
[历史 v0.0.1 发布说明](./docs/releases/v0.0.1.md)。

当前限制包括：

- 支持 macOS Universal 与 Windows 10/11 x64，但仍只支持单个 `main.c`；
  多文件工程尚未进入事实源模型。
- Trace 证明执行行与分支路径，不采集任意运行时变量值。
- 宏、`goto`、解析恢复和 partial CFG 可能降低结构化编辑能力。
- Seatbelt 是最佳努力隔离；关键隔离能力不可用时，运行器会拒绝执行或要求
  用户针对该次可信请求明确授权。
- Windows Job Object 只限制进程树、内存和 CPU，不提供文件或网络隔离。
- 当前 macOS 与 Windows `v0.0.2-preview.2` 都未使用受信任发布者签名；稳定
  包尚未发布。

本项目采用 [MIT License](./LICENSE)。报告漏洞请遵循
[Security Policy](./SECURITY.md)，不要在公开 Issue 中披露可利用细节。
