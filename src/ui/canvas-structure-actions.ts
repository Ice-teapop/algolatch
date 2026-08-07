import type { FlowEdge, FlowNode, FlowPoint } from "../flow/index.js";
import type { InterfaceLocale } from "../shared/interface-locale.js";
import {
  createStructureInsertEditor,
  type StructureInsertEditor,
} from "./structure-insert-editor.js";

export type CanvasStructureActionKind =
  "insert-before" | "insert-after" | "move-previous" | "move-next" | "edit";

export type CanvasStructureActionOrigin = "toolbar" | "context-menu";

interface CanvasStructureActionBase {
  readonly sourceFingerprint: string;
  readonly nodeId: string;
  readonly sourceNodeId: string;
  readonly nodeKind: FlowNode["kind"];
  readonly origin: CanvasStructureActionOrigin;
}

export type CanvasStructureAction =
  | (CanvasStructureActionBase & {
      readonly kind: "insert-before" | "insert-after";
      readonly statementText: string;
    })
  | (CanvasStructureActionBase & {
      readonly kind: "move-previous" | "move-next" | "edit";
    });

export interface CanvasStructureAvailability {
  readonly editable: boolean;
  readonly insertBefore: boolean;
  readonly insertAfter: boolean;
  readonly movePrevious: boolean;
  readonly moveNext: boolean;
  readonly edit: boolean;
  readonly reason: string | null;
}

export interface CanvasStructureNeighborContext {
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export type CanvasEdgeInsertMode = "presets" | "custom";

export interface CanvasEdgeInsertRequest {
  readonly sourceFingerprint: string;
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly fromPortId: string;
  readonly toNodeId: string;
  readonly toPortId: string;
  readonly edgeKind: "entry" | "next" | "return";
  readonly worldPosition: FlowPoint;
  readonly mode: CanvasEdgeInsertMode;
  readonly statementText: string | null;
}

export interface CanvasEdgeInsertionAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface CanvasEdgeInsertPreset {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly description: string;
}

export interface CanvasStructureControls {
  readonly root: HTMLElement;
  readonly note: HTMLParagraphElement;
  readonly insertBefore: HTMLButtonElement;
  readonly insertAfter: HTMLButtonElement;
  readonly movePrevious: HTMLButtonElement;
  readonly moveNext: HTMLButtonElement;
  readonly edit: HTMLButtonElement;
  readonly editor: HTMLElement;
  readonly editorLabel: HTMLParagraphElement;
  readonly insertEditor: StructureInsertEditor;
  readonly textarea: HTMLTextAreaElement;
  readonly submit: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

export interface CanvasEdgeInsertControls {
  readonly root: HTMLElement;
  readonly title: HTMLParagraphElement;
  readonly presetList: HTMLDivElement;
  readonly empty: HTMLParagraphElement;
  readonly custom: HTMLButtonElement;
  readonly editor: HTMLElement;
  readonly editorLabel: HTMLParagraphElement;
  readonly insertEditor: StructureInsertEditor;
  readonly textarea: HTMLTextAreaElement;
  readonly submit: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

export function canvasStructureAvailability(
  node: FlowNode,
  locale: InterfaceLocale = "zh-CN",
  neighbors?: CanvasStructureNeighborContext,
): CanvasStructureAvailability {
  const reason = structureUnavailableReason(node, locale);
  const editable = reason === null;
  return Object.freeze({
    editable,
    insertBefore: editable,
    insertAfter: editable,
    movePrevious: editable && (neighbors?.hasPrevious ?? true),
    moveNext: editable && (neighbors?.hasNext ?? true),
    edit: editable,
    reason,
  });
}

export function createCanvasStructureAction(
  sourceFingerprint: string,
  node: FlowNode,
  kind: CanvasStructureActionKind,
  statementText: string | null,
  origin: CanvasStructureActionOrigin,
): CanvasStructureAction {
  assertSourceFingerprint(sourceFingerprint);
  const availability = canvasStructureAvailability(node);
  if (!availability.editable || node.sourceNodeId === null) {
    throw new TypeError(availability.reason ?? "节点不可进行结构编辑");
  }
  const base = Object.freeze({
    sourceFingerprint,
    nodeId: node.id,
    sourceNodeId: node.sourceNodeId,
    nodeKind: node.kind,
    origin,
  });
  if (kind === "insert-before" || kind === "insert-after") {
    const normalized = statementText?.trim() ?? "";
    if (normalized.length === 0) throw new TypeError("Inserted C source cannot be empty.");
    return Object.freeze({ ...base, kind, statementText: normalized });
  }
  return Object.freeze({ ...base, kind });
}

export function canvasEdgeInsertionAvailability(
  edge: FlowEdge,
  locale: InterfaceLocale = "zh-CN",
): CanvasEdgeInsertionAvailability {
  const available =
    edge.channel === "control" &&
    (edge.kind === "entry" || edge.kind === "next" || edge.kind === "return");
  return Object.freeze({
    available,
    reason: available
      ? null
      : locale === "en"
        ? "Only function entry, sequential, and function-exit control edges accept inserted blocks."
        : "只有函数入口、顺序执行和函数出口控制边可以插入积木。",
  });
}

export function createCanvasEdgeInsertRequest(
  sourceFingerprint: string,
  edge: FlowEdge,
  worldPosition: FlowPoint,
  mode: CanvasEdgeInsertMode,
  statementText: string | null,
): CanvasEdgeInsertRequest {
  assertSourceFingerprint(sourceFingerprint);
  const availability = canvasEdgeInsertionAvailability(edge);
  if (
    !availability.available ||
    (edge.kind !== "entry" && edge.kind !== "next" && edge.kind !== "return")
  ) {
    throw new TypeError(
      "Only function entry, sequential, and function-exit edges accept insertion.",
    );
  }
  if (!Number.isFinite(worldPosition.x) || !Number.isFinite(worldPosition.y)) {
    throw new TypeError("边插入位置必须是有限坐标");
  }
  const normalized = statementText?.trim() ?? "";
  if (mode === "custom" && normalized.length === 0) {
    throw new TypeError("自定义边插入源码不能为空");
  }
  return Object.freeze({
    sourceFingerprint,
    edgeId: edge.id,
    fromNodeId: edge.from.nodeId,
    fromPortId: edge.from.portId,
    toNodeId: edge.to.nodeId,
    toPortId: edge.to.portId,
    edgeKind: edge.kind,
    worldPosition: Object.freeze({ x: worldPosition.x, y: worldPosition.y }),
    mode,
    statementText: mode === "custom" ? normalized : null,
  });
}

export function createCanvasStructureControls(ownerDocument: Document): CanvasStructureControls {
  const root = ownerDocument.createElement("aside");
  root.className = "flow-canvas__structure-actions";
  root.dataset.flowStructureActions = "true";
  root.setAttribute("role", "toolbar");
  root.hidden = true;
  const note = ownerDocument.createElement("p");
  note.className = "flow-canvas__structure-note";
  const actions = ownerDocument.createElement("div");
  actions.className = "flow-canvas__structure-buttons";
  const insertBefore = structureActionButton(ownerDocument, "insert-before");
  const insertAfter = structureActionButton(ownerDocument, "insert-after");
  const movePrevious = structureActionButton(ownerDocument, "move-previous");
  const moveNext = structureActionButton(ownerDocument, "move-next");
  const edit = structureActionButton(ownerDocument, "edit");
  actions.append(insertBefore, insertAfter, movePrevious, moveNext, edit);
  const editor = ownerDocument.createElement("section");
  editor.className = "flow-canvas__structure-editor";
  editor.hidden = true;
  const editorLabel = ownerDocument.createElement("p");
  editorLabel.className = "flow-canvas__structure-editor-direction";
  const insertEditor = createStructureInsertEditor(ownerDocument, "zh-CN", "", () => undefined);
  const footer = ownerDocument.createElement("div");
  footer.className = "flow-canvas__structure-editor-actions";
  const submit = ownerDocument.createElement("button");
  submit.type = "button";
  submit.className = "button button--primary";
  submit.dataset.flowStructureSubmit = "true";
  const cancel = ownerDocument.createElement("button");
  cancel.type = "button";
  cancel.className = "button button--quiet";
  cancel.dataset.flowStructureCancel = "true";
  footer.append(submit, cancel);
  editor.append(editorLabel, insertEditor.field, insertEditor.hint, footer);
  root.append(note, actions, editor);
  return Object.freeze({
    root,
    note,
    insertBefore,
    insertAfter,
    movePrevious,
    moveNext,
    edit,
    editor,
    editorLabel,
    insertEditor,
    textarea: insertEditor.input,
    submit,
    cancel,
  });
}

export function createCanvasEdgeInsertControls(ownerDocument: Document): CanvasEdgeInsertControls {
  const root = ownerDocument.createElement("aside");
  root.className = "flow-canvas__edge-insert-menu";
  root.dataset.flowEdgeInsertMenu = "true";
  root.setAttribute("role", "dialog");
  root.hidden = true;
  const title = ownerDocument.createElement("p");
  title.className = "flow-canvas__edge-insert-title";
  title.id = `flow-edge-insert-title-${String(nextEdgeInsertControlId++)}`;
  root.setAttribute("aria-labelledby", title.id);
  const choices = ownerDocument.createElement("div");
  choices.className = "flow-canvas__edge-insert-choices";
  const presetList = ownerDocument.createElement("div");
  presetList.className = "flow-canvas__edge-insert-presets";
  presetList.dataset.flowEdgeInsertPresets = "true";
  presetList.setAttribute("role", "group");
  const empty = ownerDocument.createElement("p");
  empty.className = "flow-canvas__edge-insert-empty";
  const custom = ownerDocument.createElement("button");
  custom.type = "button";
  custom.dataset.flowEdgeInsertCustom = "true";
  choices.append(presetList, empty, custom);
  const editor = ownerDocument.createElement("section");
  editor.className = "flow-canvas__structure-editor";
  editor.hidden = true;
  const editorLabel = ownerDocument.createElement("p");
  editorLabel.className = "flow-canvas__structure-editor-direction";
  const insertEditor = createStructureInsertEditor(ownerDocument, "zh-CN", "", () => undefined);
  const footer = ownerDocument.createElement("div");
  footer.className = "flow-canvas__structure-editor-actions";
  const submit = ownerDocument.createElement("button");
  submit.type = "button";
  submit.className = "button button--primary";
  submit.dataset.flowEdgeInsertSubmit = "true";
  const cancel = ownerDocument.createElement("button");
  cancel.type = "button";
  cancel.className = "button button--quiet";
  cancel.dataset.flowEdgeInsertCancel = "true";
  footer.append(submit, cancel);
  editor.append(editorLabel, insertEditor.field, insertEditor.hint, footer);
  root.append(title, choices, editor);
  return Object.freeze({
    root,
    title,
    presetList,
    empty,
    custom,
    editor,
    editorLabel,
    insertEditor,
    textarea: insertEditor.input,
    submit,
    cancel,
  });
}

let nextEdgeInsertControlId = 1;

function structureUnavailableReason(node: FlowNode, locale: InterfaceLocale): string | null {
  if (node.locked || node.kind === "raw") {
    const reason = node.lockReasons[0];
    if (locale !== "en") return reason?.message ?? "该节点被锁定，不能改写结构。";
    if (reason?.code === "partial-cfg") {
      return "This node belongs to an incomplete CFG and cannot be reordered.";
    }
    if (reason?.code === "raw-block" || node.kind === "raw") {
      return "Raw or parser-recovery source cannot be safely reordered.";
    }
    if (reason?.code === "translation-unit") {
      return "Translation-unit source cannot be reordered inside a function.";
    }
    return "This node is locked and cannot change source structure.";
  }
  if (node.kind === "start" || node.kind === "end") {
    return locale === "en"
      ? "This boundary does not generate an independent C statement."
      : "该边界不生成独立 C 语句。";
  }
  if (node.kind === "module" || node.functionId === null) {
    return locale === "en"
      ? "Translation-unit source is not part of a function statement list."
      : "Translation Unit 源码不属于函数语句列表。";
  }
  if (node.sourceNodeId === null || node.sourceText.trim().length === 0) {
    return locale === "en"
      ? "This projection has no exact source statement to edit."
      : "该投影没有可精确编辑的源码语句。";
  }
  return null;
}

function assertSourceFingerprint(value: string): void {
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new TypeError("源码指纹不能为空或包含首尾空白");
  }
}

function structureActionButton(
  ownerDocument: Document,
  kind: CanvasStructureActionKind,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.dataset.flowStructureAction = kind;
  return button;
}
