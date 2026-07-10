# Fuzz regressions

M1 变异 fuzz 失败时，测试会把 fast-check 缩减后的最小源码写为 `m1-<sha256>.c`，并把 seed 与变异参数写入同名 `.json`。失败样本必须保留并转成永久回归测试，不可为恢复绿灯而删除。

当前保留 `m1-b0f4d789bbdd`：匿名坏声明 `int [64];` 曾让符号投影生成空 range；现由 statement-projector 定向测试与固定 seed fuzz 共同回归。

当前保留 `m1-99114c916fd6`：删除首行后留下的 leading newline 会让 Tree-sitter 根节点从 offset 1 开始；现由 M3b parser integration 定向测试与固定 seed fuzz 共同回归，statement target 提取只容许 CST 外的 BOM/空白 trivia，并继续逐字校验根节点覆盖区。
