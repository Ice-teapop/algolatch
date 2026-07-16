import type { CfgEdgeKind, CfgPartialReasonCode } from "../analysis/model.js";
import type { RawReason, TextRange } from "../core/model.js";

export const FLOW_PROJECTION_SCHEMA_VERSION = 1 as const;
export const FLOW_VIEW_STATE_SCHEMA_VERSION = 2 as const;
export const FLOW_NODE_ANCHOR_SCHEMA_VERSION = 1 as const;

export interface FlowPoint {
  readonly x: number;
  readonly y: number;
}

export interface FlowViewport extends FlowPoint {
  readonly zoom: number;
}

export type FlowNodeKind =
  | "module"
  | "start"
  | "end"
  | "statement"
  | "declaration"
  | "branch"
  | "loop"
  | "switch"
  | "assert"
  | "control"
  | "raw";

export type FlowPortDirection = "input" | "output";
export type FlowPortChannel = "control" | "data";
export type FlowPortCapacity = "one" | "many";

export type FlowLockReasonCode = "translation-unit" | "partial-cfg" | "raw-block";

export interface FlowLockReason {
  readonly code: FlowLockReasonCode;
  readonly message: string;
  readonly range: TextRange;
  readonly partialCode: CfgPartialReasonCode | null;
  readonly rawReason: RawReason | null;
}

export interface FlowPort {
  readonly id: string;
  readonly nodeId: string;
  readonly direction: FlowPortDirection;
  readonly channel: FlowPortChannel;
  readonly edgeKind: CfgEdgeKind | null;
  readonly label: string;
  readonly editable: boolean;
  readonly capacity: FlowPortCapacity;
  /** True only when one semantic port may own more than one outgoing edge. */
  readonly allowsFanOut: boolean;
}

export interface FlowNode {
  readonly id: string;
  readonly functionId: string | null;
  readonly sourceNodeId: string | null;
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly nodeType: string | null;
  readonly range: TextRange;
  readonly ownerBlockRange: TextRange;
  readonly sourceText: string;
  readonly reachable: boolean;
  readonly locked: boolean;
  readonly lockReasons: readonly FlowLockReason[];
  readonly allowsFanOut: boolean;
  readonly defaultPosition: FlowPoint;
  readonly ports: readonly FlowPort[];
}

export interface FlowEdgeEndpoint {
  readonly nodeId: string;
  readonly portId: string;
}

export interface FlowEdge {
  readonly id: string;
  readonly functionId: string;
  readonly from: FlowEdgeEndpoint;
  readonly to: FlowEdgeEndpoint;
  readonly kind: CfgEdgeKind;
  readonly channel: "control";
  /** Stable zero-based lane among edges with the same source and semantic kind. */
  readonly slot: number;
  readonly editable: boolean;
}

export interface FlowDataEdge {
  readonly id: string;
  readonly functionId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly variableId: string;
  readonly variableName: string;
  readonly channel: "data";
  readonly editable: false;
}

export interface FlowFunctionProjection {
  readonly id: string;
  readonly name: string;
  readonly range: TextRange;
  readonly entryNodeId: string;
  readonly exitNodeId: string;
  readonly partial: boolean;
  readonly lockReasons: readonly FlowLockReason[];
}

export interface FlowProjection {
  readonly schemaVersion: typeof FLOW_PROJECTION_SCHEMA_VERSION;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly sourceLength: number;
  readonly documentHasError: boolean;
  readonly functions: readonly FlowFunctionProjection[];
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  /** Proven reaching-definition relations only; rendered as read-only dashed wires. */
  readonly dataEdges: readonly FlowDataEdge[];
}

export interface FlowViewState {
  readonly schemaVersion: typeof FLOW_VIEW_STATE_SCHEMA_VERSION;
  readonly sourceFingerprint: string;
  readonly viewport: FlowViewport;
  readonly positions: Readonly<Record<string, FlowPoint>>;
  readonly selectedNodeIds: readonly string[];
  readonly detailNodeId: string | null;
}

/** Persisted identity for a projected node. It deliberately excludes snapshot-local node IDs. */
export interface FlowNodeAnchor {
  readonly schemaVersion: typeof FLOW_NODE_ANCHOR_SCHEMA_VERSION;
  readonly sourceFingerprint: string;
  readonly structurePath: string;
  readonly kind: FlowNodeKind;
  readonly nodeType: string | null;
  readonly range: TextRange;
  readonly textFingerprint: string;
}

export type FlowNodeAnchorResolution =
  | { readonly status: "resolved"; readonly nodeId: string }
  | {
      readonly status: "unresolved";
      readonly code: "invalid-anchor" | "anchor-mismatch" | "ambiguous-anchor";
      readonly message: string;
    };

export type FlowViewStateIssueCode =
  | "invalid-json"
  | "invalid-shape"
  | "unsupported-version"
  | "stale-source"
  | "invalid-viewport"
  | "invalid-position"
  | "invalid-anchor"
  | "anchor-mismatch"
  | "ambiguous-anchor"
  | "legacy-stale-source"
  | "legacy-generated-layout"
  | "unknown-node"
  | "duplicate-selection";

export interface FlowViewStateIssue {
  readonly code: FlowViewStateIssueCode;
  readonly path: string;
  readonly message: string;
}

export type FlowViewStateValidation =
  | {
      readonly ok: true;
      readonly value: FlowViewState;
      /** Non-fatal per-anchor recovery issues. The returned state remains safe to use. */
      readonly issues: readonly FlowViewStateIssue[];
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly issues: readonly FlowViewStateIssue[];
    };

export interface ConnectionIntent {
  readonly sourceFingerprint: string;
  readonly fromNodeId: string;
  readonly fromPortId: string | null;
  readonly toNodeId: string;
  readonly toPortId: string | null;
  readonly kind: CfgEdgeKind;
  /** Null adds an edge; otherwise the named edge is displaced by this connection. */
  readonly replaceEdgeId: string | null;
}

export type ConnectionRejectionCode =
  | "stale-source"
  | "unknown-source-node"
  | "unknown-target-node"
  | "same-node"
  | "locked-node"
  | "source-is-end"
  | "target-is-start"
  | "cross-function"
  | "unsupported-kind"
  | "invalid-source-port"
  | "invalid-target-port"
  | "invalid-target"
  | "duplicate-edge"
  | "fan-out-not-supported"
  | "port-capacity"
  | "unsafe-cycle"
  | "replacement-not-found"
  | "replacement-mismatch";

export type ConnectionPostcondition =
  | "exact-source-diff"
  | "source-reparse"
  | "source-roundtrip"
  | "cfg-edge-match"
  | "no-new-partial-cfg";

export interface AcceptedConnectionPlan {
  readonly status: "accepted";
  readonly intent: ConnectionIntent;
  readonly operation: "add" | "replace";
  readonly candidateEdge: FlowEdge;
  readonly displacedEdgeIds: readonly string[];
  /** This domain never fabricates a C patch. A write adapter must satisfy every postcondition. */
  readonly cSourcePatch: null;
  readonly requiredPostconditions: readonly ConnectionPostcondition[];
}

export interface RejectedConnectionPlan {
  readonly status: "rejected";
  readonly intent: ConnectionIntent;
  readonly code: ConnectionRejectionCode;
  readonly message: string;
}

export type ConnectionPlan = AcceptedConnectionPlan | RejectedConnectionPlan;
