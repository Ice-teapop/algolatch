import type { InterfaceLocale } from "../shared/interface-locale.js";

export interface CCommandCopy {
  readonly heading: string;
  readonly description: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly shortcutHint: string;
  readonly stdinLabel: string;
  readonly stdinPlaceholder: string;
  readonly run: string;
  readonly cancelRun: string;
  readonly compiling: string;
  readonly running: string;
  readonly compileFailed: string;
  readonly runFailed: string;
  readonly succeeded: string;
  readonly cancelled: string;
  readonly internalError: string;
  readonly wrapperLabel: string;
  readonly wrapperHint: string;
  readonly diagnostics: string;
  readonly cellDiagnosticSource: string;
  readonly generatedWrapperDiagnosticSource: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: string;
  readonly exitCode: string;
  readonly runTime: string;
  readonly peakMemory: string;
  readonly unavailable: string;
  readonly continueEditing: string;
  readonly writeToMain: string;
  readonly clearResult: string;
  readonly emptyInput: string;
  readonly projectionPending: string;
  readonly runnerErrors: Readonly<Record<string, string>>;
}

const COPY: Readonly<Record<InterfaceLocale, CCommandCopy>> = Object.freeze({
  "zh-CN": Object.freeze({
    heading: "运行单元",
    description: "每个单元独立重新编译，不保留上一个单元的变量状态。",
    inputLabel: "输入 C 程序、语句或控制块",
    placeholder: '例如：printf("Hello, AlgoLatch!\\n");',
    shortcutHint: "⌘/Ctrl+Enter 运行 · Shift+Enter 换行 · Tab 缩进 · Esc 取消",
    stdinLabel: "标准输入 stdin",
    stdinPlaceholder: "程序需要输入；在这里粘贴或逐行输入",
    run: "运行此单元",
    cancelRun: "取消运行",
    compiling: "正在编译",
    running: "正在运行",
    compileFailed: "编译未通过",
    runFailed: "运行失败",
    succeeded: "运行完成",
    cancelled: "已取消",
    internalError: "运行器错误",
    wrapperLabel: "运行包装代码",
    wrapperHint: "该包装只用于本次运行，未经确认不会写入 main.c。",
    diagnostics: "编译诊断",
    cellDiagnosticSource: "运行单元",
    generatedWrapperDiagnosticSource: "生成的运行包装",
    stdout: "输出",
    stderr: "错误输出",
    outputTruncated: "实时输出已达到显示上限；最终结果仍以运行完成后的证据为准。",
    exitCode: "退出码",
    runTime: "耗时",
    peakMemory: "内存峰值",
    unavailable: "不可用",
    continueEditing: "继续编辑",
    writeToMain: "写入 main.c",
    clearResult: "清除结果",
    emptyInput: "请输入 C 代码后再运行。",
    projectionPending: "正在输入",
    runnerErrors: Object.freeze({
      INVALID_REQUEST: "运行请求无效。",
      RUNNER_DISABLED: "本地运行器已停用。",
      RUNNER_BUSY: "本地运行器正忙，请稍后再试。",
      RUNNER_SHUTTING_DOWN: "本地运行器正在关闭。",
      SANDBOX_UNAVAILABLE: "当前系统无法提供所需的运行隔离。",
      TRUST_CONFIRMATION_REQUIRED: "本次运行需要一次明确授权。",
      ARTIFACT_NOT_FOUND: "编译产物已不存在，请重新运行。",
      ARTIFACT_EXPIRED: "编译产物已过期，请重新运行。",
      ARTIFACT_CAPACITY_REACHED: "编译产物暂存区已满，请稍后再试。",
      COMPILE_FAILED: "C 编译未通过；请查看上方诊断。",
      RESOURCE_LIMIT: "程序触发了运行资源限制。",
      PROCESS_SPAWN_FAILED: "无法启动编译后的程序。",
      PROCESS_CONTROL_FAILED: "无法安全控制本次运行。",
      CANCELLED: "本次运行已取消。",
      INTERNAL_ERROR: "本地运行器遇到内部错误。",
    }),
  }),
  en: Object.freeze({
    heading: "C Cell",
    description:
      "Each cell is compiled independently and does not retain variables from the previous cell.",
    inputLabel: "Enter a C program, statement, or control block",
    placeholder: 'Example: printf("Hello, AlgoLatch!\\n");',
    shortcutHint: "⌘/Ctrl+Enter run · Shift+Enter newline · Tab indent · Esc cancel",
    stdinLabel: "Standard input (stdin)",
    stdinPlaceholder: "This program reads input; paste or enter it line by line",
    run: "Run cell",
    cancelRun: "Cancel run",
    compiling: "Compiling",
    running: "Running",
    compileFailed: "Compile failed",
    runFailed: "Run failed",
    succeeded: "Run completed",
    cancelled: "Cancelled",
    internalError: "Runner error",
    wrapperLabel: "Generated run wrapper",
    wrapperHint: "This wrapper is only for this run and is never written to main.c without review.",
    diagnostics: "Compiler diagnostics",
    cellDiagnosticSource: "C Cell",
    generatedWrapperDiagnosticSource: "generated wrapper",
    stdout: "Output",
    stderr: "Error output",
    outputTruncated:
      "Live output reached the display limit; the completed run evidence remains authoritative.",
    exitCode: "Exit code",
    runTime: "Duration",
    peakMemory: "Peak memory",
    unavailable: "Unavailable",
    continueEditing: "Continue editing",
    writeToMain: "Write to main.c",
    clearResult: "Clear result",
    emptyInput: "Enter C code before running.",
    projectionPending: "Typing",
    runnerErrors: Object.freeze({
      INVALID_REQUEST: "The run request is invalid.",
      RUNNER_DISABLED: "The local runner is disabled.",
      RUNNER_BUSY: "The local runner is busy. Try again shortly.",
      RUNNER_SHUTTING_DOWN: "The local runner is shutting down.",
      SANDBOX_UNAVAILABLE: "The required run isolation is unavailable on this system.",
      TRUST_CONFIRMATION_REQUIRED: "This run requires explicit one-time authorization.",
      ARTIFACT_NOT_FOUND: "The compiled artifact is no longer available. Run the cell again.",
      ARTIFACT_EXPIRED: "The compiled artifact expired. Run the cell again.",
      ARTIFACT_CAPACITY_REACHED: "The compiled-artifact store is full. Try again shortly.",
      COMPILE_FAILED: "C compilation did not succeed. Review the diagnostics above.",
      RESOURCE_LIMIT: "The program reached a supervised resource limit.",
      PROCESS_SPAWN_FAILED: "The compiled program could not be started.",
      PROCESS_CONTROL_FAILED: "The run could not be controlled safely.",
      CANCELLED: "The run was cancelled.",
      INTERNAL_ERROR: "The local runner encountered an internal error.",
    }),
  }),
});

export function getCCommandCopy(locale: InterfaceLocale): CCommandCopy {
  return COPY[locale];
}
