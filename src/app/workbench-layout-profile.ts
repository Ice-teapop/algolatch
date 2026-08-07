import type { ResizableLayoutSnapshot } from "../ui/resizable-layout.js";

export const CURRENT_WORKBENCH_LAYOUT_PROFILE = "c-cell-v1";
const LEGACY_LAYOUT_IDS = new Set(["main", "work", "primary", "right"]);

export interface WorkbenchLayoutRestorePlan {
  readonly snapshots: Readonly<Record<string, ResizableLayoutSnapshot>>;
  readonly resetLayoutIds: readonly string[];
}

/** Resets only panes whose meaning changed under the C Cell hierarchy. */
export function planWorkbenchLayoutRestore(
  savedProfile: string | undefined,
  snapshots: Readonly<Record<string, ResizableLayoutSnapshot>>,
): WorkbenchLayoutRestorePlan {
  if (savedProfile === CURRENT_WORKBENCH_LAYOUT_PROFILE) {
    return Object.freeze({ snapshots, resetLayoutIds: Object.freeze([]) });
  }
  return Object.freeze({
    snapshots: Object.freeze(
      Object.fromEntries(Object.entries(snapshots).filter(([id]) => !LEGACY_LAYOUT_IDS.has(id))),
    ),
    resetLayoutIds: Object.freeze([...LEGACY_LAYOUT_IDS]),
  });
}
