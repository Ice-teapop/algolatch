import { describe, expect, it } from "vitest";
import { createDeferredNotificationQueue } from "../../src/ui/deferred-notification-queue.js";

describe("deferred notification queue", () => {
  it("delivers same-tick A-B-A transitions in FIFO order", () => {
    const scheduled: Array<() => void> = [];
    const delivered: string[] = [];
    const queue = createDeferredNotificationQueue<string>(
      (value) => delivered.push(value),
      (callback) => scheduled.push(callback),
    );

    queue.enqueue("A");
    queue.enqueue("B");
    queue.enqueue("A");
    for (const callback of scheduled) callback();

    expect(delivered).toEqual(["A", "B", "A"]);
  });

  it("invalidates queued values at a reset boundary", () => {
    const scheduled: Array<() => void> = [];
    const delivered: string[] = [];
    const queue = createDeferredNotificationQueue<string>(
      (value) => delivered.push(value),
      (callback) => scheduled.push(callback),
    );

    queue.enqueue("stale");
    queue.reset();
    queue.enqueue("current");
    for (const callback of scheduled) callback();

    expect(delivered).toEqual(["current"]);
  });

  it("invalidates queued values when destroyed", () => {
    const scheduled: Array<() => void> = [];
    const delivered: string[] = [];
    const queue = createDeferredNotificationQueue<string>(
      (value) => delivered.push(value),
      (callback) => scheduled.push(callback),
    );

    queue.enqueue("stale");
    queue.destroy();
    for (const callback of scheduled) callback();

    expect(delivered).toEqual([]);
    expect(() => queue.enqueue("late")).toThrow(/已销毁/u);
  });
});
