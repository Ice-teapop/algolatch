export interface WorkspaceLifecycleOptions {
  readonly workspace: {
    readonly hasUnsavedChanges: boolean;
    flush(): Promise<void>;
  };
  readonly onCloseRequested: (handler: () => Promise<void>) => () => void;
  readonly destroy: () => void;
  readonly targetWindow?: Window | undefined;
  readonly reload?: (() => void) | undefined;
}

export interface WorkspaceLifecycle {
  destroy(): void;
}

/** Flushes managed source before window close or renderer reload. */
export function installWorkspaceLifecycle(options: WorkspaceLifecycleOptions): WorkspaceLifecycle {
  assertOptions(options);
  const targetWindow = options.targetWindow ?? globalThis.window;
  const reload = options.reload ?? (() => targetWindow.location.reload());
  let destroyed = false;
  let unloadAuthorized = false;
  let unloadFlushInFlight = false;

  const removeCloseHandler = options.onCloseRequested(() => options.workspace.flush());

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    removeCloseHandler();
    targetWindow.removeEventListener("beforeunload", onBeforeUnload);
    options.destroy();
  };

  const flushAndReload = (): void => {
    if (unloadFlushInFlight) return;
    unloadFlushInFlight = true;
    void options.workspace.flush().then(
      () => {
        unloadAuthorized = true;
        destroy();
        reload();
      },
      () => {
        unloadFlushInFlight = false;
      },
    );
  };

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (unloadAuthorized || !options.workspace.hasUnsavedChanges) {
      destroy();
      return;
    }
    event.preventDefault();
    event.returnValue = false;
    flushAndReload();
  }

  targetWindow.addEventListener("beforeunload", onBeforeUnload);
  return Object.freeze({ destroy });
}

function assertOptions(options: WorkspaceLifecycleOptions): void {
  if (
    typeof options.workspace?.flush !== "function" ||
    typeof options.onCloseRequested !== "function" ||
    typeof options.destroy !== "function"
  ) {
    throw new TypeError("workspace lifecycle options 无效");
  }
}
