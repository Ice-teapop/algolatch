export interface DeferredNotificationQueue<T> {
  enqueue(value: T): void;
  reset(): void;
  destroy(): void;
}

export type NotificationScheduler = (callback: () => void) => void;

/**
 * Delivers every value in FIFO microtask order within one epoch. Resetting an
 * import boundary, or destroying the owner, invalidates all queued old values.
 */
export function createDeferredNotificationQueue<T>(
  deliver: (value: T) => void,
  schedule: NotificationScheduler = queueMicrotask,
): DeferredNotificationQueue<T> {
  if (typeof deliver !== "function" || typeof schedule !== "function") {
    throw new TypeError("deferred notification callbacks 无效");
  }
  let epoch = 0;
  let destroyed = false;

  return Object.freeze({
    enqueue(value: T): void {
      assertActive(destroyed);
      const queuedEpoch = epoch;
      schedule(() => {
        if (!destroyed && queuedEpoch === epoch) deliver(value);
      });
    },
    reset(): void {
      assertActive(destroyed);
      epoch += 1;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      epoch += 1;
    },
  });
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("deferred notification queue 已销毁");
}
