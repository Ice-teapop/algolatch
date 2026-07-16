# ADR-0007：Windows 内置运行时与安装包边界

- 状态：Accepted
- 日期：2026-07-15

## 背景

Windows 10/11 不自带可供普通用户稳定调用的 C 编译器。要求用户预装 Visual
Studio、LLVM 或修改系统 `PATH`，会破坏 AlgoLatch 的“下载安装即可学习”目标。
同时，Windows 没有与当前 macOS Seatbelt 配置等价的内置应用级沙箱；仅限制
进程数量和资源，并不能阻止原生程序访问用户有权访问的文件或网络。

Windows 分发还必须区分三个独立问题：安装器是否需要管理员权限、发布物是否
具有 Authenticode 签名，以及未知发行者在 Microsoft SmartScreen 中是否已经
建立信誉。代码签名不会立即获得 SmartScreen 信誉。

## 决策

1. 首个 Windows 目标只支持 Windows 10/11 x64。
2. 安装包使用 NSIS one-click per-user 模式，应用请求级别为 `asInvoker`，不要求
   管理员权限。卸载应用时保留 Documents 中的项目。
3. Windows 包内置锁定的 llvm-mingw x64 子集。构建只从固定 HTTPS URL 下载，
   校验固定大小与 SHA-256，拒绝危险归档路径，并把所需编译器、链接器、头文件
   和库放入 `resources/windows-runtime/`。安装后不再下载编译器。
4. 主进程只接受与内置 manifest 匹配的工具链版本、目标三元组和关键文件摘要。
   缺失、被替换或摘要不符时，编译运行能力 fail closed。
5. 用户程序由 `algolatch-job-host.exe` 在 Windows Job Object 中启动。broker 在
   恢复目标进程前设置进程数、聚合内存和 CPU 时间限制，并在 Job 关闭时终止
   整个进程树。
6. Windows Job Object 只提供资源和进程树约束，不提供文件系统或网络隔离。
   界面、安全文档和运行能力说明必须明确这一点；未知 C 仍按原生可执行代码
   对待。
7. 正式 NSIS 安装器、`AlgoLatch.exe` 和卸载器必须通过同一 Authenticode 发布
   门禁及安装态回归。未签名 Beta 使用独立目录和带 `unsigned` 的文件名。
8. 内置 llvm-mingw EXE 与 Job Object broker 在 staging 时写入摘要。构建器不得
   在复制后再改写这些文件；正式配置显式排除这些嵌套 EXE 的二次签名，依靠
   已签名安装器的交付边界和运行时固定摘要检测。若以后增加新的嵌套 EXE，
   必须同步扩展排除项，或改用“签名后生成 manifest”的构建 hook。
9. 正式 macOS 与 Windows 资产分别要求各自的平台签名和安装态门禁；一个平台
   可以独立发布，不得借用另一平台的验证结论。若同一 Release 同时包含两种
   资产，则两个平台门禁都必须通过。未签名 Preview 必须使用独立 prerelease、
   带 `unsigned` 的文件名和统一 SHA-256 清单。已发布资产不覆盖。

## 结果

- Windows 用户无需另装 C 编译器，也无需管理员权限即可安装和使用主要功能。
- Windows 包显著增大，发布 CI 需要下载并验证固定 llvm-mingw 归档。
- Job Object 能可靠回收进程树和限制资源，但不能把不可信 C 变成安全文档。
- Authenticode 能证明发布者与文件完整性，但新证书或低下载量仍可能触发
  SmartScreen 信誉提示。
- Windows 稳定包必须具有可验证的 Authenticode；在证书和安装态门禁就绪前，
  本决策只代表实现和发布准备完成，不代表 Windows 稳定版已经发布。
