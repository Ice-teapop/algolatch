const DEFAULT_SOURCE_NAME = "c-command.c";
const GENERATED_WRAPPER_MARKER = "ALGOLATCH_C_COMMAND_WRAPPER";
const GENERATED_INPUT_BEGIN_MARKER = "ALGOLATCH_C_COMMAND_INPUT_BEGIN";
const GENERATED_INPUT_END_MARKER = "ALGOLATCH_C_COMMAND_INPUT_END";
const utf8Encoder = new TextEncoder();

export type CCommandInputKind = "translation-unit" | "fragment";

export interface CCommandWrapperMapping {
  readonly generated: boolean;
  readonly inputStartLine: number;
  readonly inputEndLine: number;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
  readonly lineOffset: number;
}

export interface CCommandProjection {
  readonly kind: CCommandInputKind;
  readonly input: string;
  readonly source: string;
  readonly sourceName: string;
  readonly wrapperMapping: CCommandWrapperMapping;
}

export interface CCommandProjectionAssessment {
  readonly status: "valid" | "incomplete" | "invalid";
  readonly errorCoverageRatio: number | null;
}

export interface CCommandDiagnosticLabels {
  readonly inputSource: string;
  readonly generatedWrapperSource: string;
}

export function buildCCommandProjection(
  rawInput: string,
  sourceName = DEFAULT_SOURCE_NAME,
): CCommandProjection | null {
  const normalizedSourceName = normalizeSourceName(sourceName);
  const input = normalizeCommandInput(rawInput);
  if (input.trim().length === 0) return null;

  const kind = containsMainFunctionDefinition(input) ? "translation-unit" : "fragment";
  if (kind === "translation-unit") {
    const lineCount = countLines(input);
    return Object.freeze({
      kind,
      input,
      source: ensureTrailingNewline(input),
      sourceName: normalizedSourceName,
      wrapperMapping: Object.freeze({
        generated: false,
        inputStartLine: 1,
        inputEndLine: lineCount,
        generatedStartLine: 1,
        generatedEndLine: lineCount,
        lineOffset: 0,
      }),
    });
  }

  const prefix = [
    `/* ${GENERATED_WRAPPER_MARKER}: generated for this run; not written to main.c. */`,
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    "",
    "int main(void) {",
    `  /* ${GENERATED_INPUT_BEGIN_MARKER} */`,
  ];
  const inputLines = input.split("\n");
  const generatedInput = inputLines.map((line) => (line.length > 0 ? `  ${line}` : ""));
  const suffix = [`  /* ${GENERATED_INPUT_END_MARKER} */`, "  return 0;", "}", ""];
  const generatedStartLine = prefix.length + 1;
  const generatedEndLine = generatedStartLine + inputLines.length - 1;

  return Object.freeze({
    kind,
    input,
    source: [...prefix, ...generatedInput, ...suffix].join("\n"),
    sourceName: normalizedSourceName,
    wrapperMapping: Object.freeze({
      generated: true,
      inputStartLine: 1,
      inputEndLine: inputLines.length,
      generatedStartLine,
      generatedEndLine,
      lineOffset: generatedStartLine - 1,
    }),
  });
}

export function mapGeneratedLineToCommandInput(
  mapping: CCommandWrapperMapping,
  generatedLine: number,
): number | null {
  if (!Number.isSafeInteger(generatedLine) || generatedLine < 1) return null;
  if (generatedLine < mapping.generatedStartLine || generatedLine > mapping.generatedEndLine) {
    return null;
  }
  return generatedLine - mapping.lineOffset;
}

export function mapCCommandDiagnostics(
  diagnostics: string,
  projection: CCommandProjection,
  labels: CCommandDiagnosticLabels,
): string {
  if (diagnostics.length === 0) return diagnostics;
  const inputSource = normalizeDiagnosticLabel(labels.inputSource, "C Cell");
  const generatedWrapperSource = normalizeDiagnosticLabel(
    labels.generatedWrapperSource,
    "generated wrapper",
  );
  return diagnostics
    .split("\n")
    .map((line) =>
      mapDiagnosticLine(line, projection, {
        inputSource,
        generatedWrapperSource,
      }),
    )
    .join("\n");
}

export function assessCCommandDraft(input: string): CCommandProjectionAssessment {
  const masked = maskCommentsAndLiterals(input);
  const stack: string[] = [];
  const closingToOpening = new Map([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  for (const token of masked) {
    if (token === "(" || token === "[" || token === "{") {
      stack.push(token);
      continue;
    }
    const expectedOpening = closingToOpening.get(token);
    if (expectedOpening === undefined) continue;
    if (stack.pop() !== expectedOpening) {
      return Object.freeze({ status: "invalid", errorCoverageRatio: 1 });
    }
  }
  if (stack.length > 0 || /(?:[=+\-*/%&|^!<>?:,]|\b(?:if|for|while|switch))\s*$/u.test(masked)) {
    return Object.freeze({ status: "incomplete", errorCoverageRatio: null });
  }
  return Object.freeze({ status: "valid", errorCoverageRatio: 0 });
}

export function canPublishCCommandProjection(assessment: CCommandProjectionAssessment): boolean {
  if (assessment.status !== "valid") return false;
  return (
    assessment.errorCoverageRatio === null ||
    (Number.isFinite(assessment.errorCoverageRatio) &&
      assessment.errorCoverageRatio >= 0 &&
      assessment.errorCoverageRatio <= 0.3)
  );
}

function normalizeCommandInput(value: string): string {
  const normalized = value.replace(/^\uFEFF/u, "").replace(/\r\n?|\u2028|\u2029/gu, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[0]?.trim().length === 0) lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) lines.pop();
  return lines.join("\n");
}

function normalizeSourceName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,125}\.c$/u.test(value)) {
    throw new TypeError("sourceName must be a bounded C source file name");
  }
  return value;
}

function containsMainFunctionDefinition(source: string): boolean {
  const inspectable = maskCommentsAndLiterals(source);
  return /\b(?:int|void)\s+main\s*\([^;{}]*\)\s*\{/u.test(inspectable);
}

function maskCommentsAndLiterals(source: string): string {
  let result = "";
  let index = 0;
  let state: "code" | "line-comment" | "block-comment" | "string" | "character" = "code";

  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code" && current === "/" && next === "/") {
      result += "  ";
      index += 2;
      state = "line-comment";
      continue;
    }
    if (state === "code" && current === "/" && next === "*") {
      result += "  ";
      index += 2;
      state = "block-comment";
      continue;
    }
    if (state === "code" && current === '"') {
      result += " ";
      index += 1;
      state = "string";
      continue;
    }
    if (state === "code" && current === "'") {
      result += " ";
      index += 1;
      state = "character";
      continue;
    }
    if (state === "line-comment") {
      result += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 2;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (state === "string" || state === "character") {
      if (current === "\\") {
        result += next === "\n" ? " \n" : "  ";
        index += Math.min(2, source.length - index);
        continue;
      }
      const closing = state === "string" ? '"' : "'";
      result += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === closing) state = "code";
      continue;
    }
    result += current;
    index += 1;
  }

  return result;
}

function countLines(value: string): number {
  return value.split("\n").length;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function mapDiagnosticLine(
  line: string,
  projection: CCommandProjection,
  labels: CCommandDiagnosticLabels,
): string {
  const sourceMarker = `${projection.sourceName}:`;
  const sourceNameIndex = line.lastIndexOf(sourceMarker);
  if (sourceNameIndex < 0) return line;
  const location = /^(\d+):(\d+):/u.exec(line.slice(sourceNameIndex + sourceMarker.length));
  if (location === null) return line;

  const generatedLine = Number(location[1]);
  const generatedColumn = Number(location[2]);
  if (
    !Number.isSafeInteger(generatedLine) ||
    generatedLine < 1 ||
    !Number.isSafeInteger(generatedColumn) ||
    generatedColumn < 1
  ) {
    return line;
  }

  const sourceStart = findDiagnosticSourceStart(line, sourceNameIndex);
  const locationEnd = sourceNameIndex + sourceMarker.length + (location[0]?.length ?? 0);
  const inputLine = mapGeneratedLineToCommandInput(projection.wrapperMapping, generatedLine);
  if (inputLine === null) {
    return `${line.slice(0, sourceStart)}${labels.generatedWrapperSource}:${String(generatedLine)}:${String(generatedColumn)}:${line.slice(locationEnd)}`;
  }

  const indentationBytes = projection.wrapperMapping.generated ? 2 : 0;
  const inputByteColumn = Math.max(1, generatedColumn - indentationBytes);
  const inputLineText = projection.input.split("\n")[inputLine - 1] ?? "";
  const inputColumn = utf8ByteColumnToUtf16Column(inputLineText, inputByteColumn);
  return `${line.slice(0, sourceStart)}${labels.inputSource}:${String(inputLine)}:${String(inputColumn)}:${line.slice(locationEnd)}`;
}

function findDiagnosticSourceStart(line: string, sourceNameIndex: number): number {
  let index = sourceNameIndex;
  while (index > 0) {
    const previous = line[index - 1] ?? "";
    if (/\s|\(/u.test(previous)) break;
    index -= 1;
  }
  return index;
}

function utf8ByteColumnToUtf16Column(line: string, byteColumn: number): number {
  const targetByteOffset = Math.max(0, byteColumn - 1);
  let byteOffset = 0;
  let codeUnitOffset = 0;
  for (const character of line) {
    const characterBytes = utf8Encoder.encode(character).length;
    if (byteOffset + characterBytes > targetByteOffset) break;
    byteOffset += characterBytes;
    codeUnitOffset += character.length;
  }
  return codeUnitOffset + 1;
}

function normalizeDiagnosticLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\r\n:]/u.test(normalized)) return fallback;
  return normalized;
}
