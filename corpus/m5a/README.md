# M5a deterministic-analysis gold corpus

`cfg-gold/` 中每个目录只允许包含：

- `source.c`：一个或多个独立验收的 C 函数定义。
- `cfg.expected.json`：人工审阅的完整函数级节点、边集、partial 原因和显式 reachability。
- `expected-findings.json`：同一源码的精确分析发现；schema v2 固定 rule、reason、置信度、所属
  primary 节点和全部证据 range，测试会与当前分析器输出逐项精确比对，多报或漏报都会失败。

`manifest.json` 双向固定目录和函数数量。`sourceSha256` 将两个期望文件绑定到源码原始字节，
`sourceLengthUtf16` 与所有半开 range 使用应用的 UTF-16 坐标。节点 key 由 kind、nodeType 和 range
组成，不依赖 tree-sitter 临时 node id 或分析器内部 id；重复文本仍可区分。测试只读金标，仓库
不提供从当前实现自动录制或覆盖期望值的命令。

CFG 门禁还会独立检查：每条边的端点存在且不重复、reachability 与从 ENTRY 做的独立 BFS 一致、
每条投影语句或声明恰好归属一个 `primary` CFG 教学节点。`do` 条件可作为所属积木的 primary
控制点；`for` 初始化/更新是 `auxiliary`，必须指回一个 primary owner。`partial` 样本仍需精确列出原因。
