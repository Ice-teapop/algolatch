import { describe, expect, it } from "vitest";
import { superviseProcess } from "../../electron/main/runner/supervisor.js";
import type { SpawnSpecification } from "../../electron/main/runner/process-host.js";
import { FakeClock, FakeProcessHost, flushAsyncWork } from "./fakes.js";

const SPECIFICATION: SpawnSpecification = Object.freeze({
  command: "/bin/echo",
  args: Object.freeze([]),
  cwd: "/tmp",
  env: Object.freeze({ LANG: "C" }),
  detached: true,
  shell: false,
});

const LIMITS = Object.freeze({
  wallTimeMs: 100,
  maxOutputBytes: 5,
  maxRssBytes: 1_000,
  maxProcessCount: 64,
  rssPollIntervalMs: 10,
});

describe("superviseProcess", () => {
  it("lets the output limit win once and kills the detached process group", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    host.children[0]?.emitStdout("123456");
    clock.advanceBy(100);
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "output-limit",
      stdout: Uint8Array.from(Buffer.from("12345")),
      processControlFailed: false,
    });
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
  });

  it("keeps a wall-time decision even if output arrives later", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(100);
    host.children[0]?.emitStdout("late output");
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      stdout: new Uint8Array(),
    });
    expect(host.groupKills).toHaveLength(1);
  });

  it("clears all limit timers when process exit wins", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, Uint8Array.from([65]), LIMITS, {
      clock,
      processHost: host,
    });

    host.children[0]?.emitStdout("ok");
    host.children[0]?.emitExit(0);
    host.children[0]?.emitClose(0);
    clock.advanceBy(1_000);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      exitCode: 0,
      stdout: Uint8Array.from(Buffer.from("ok")),
    });
    expect(host.groupKills).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
    expect(host.children[0]?.inputChunks).toEqual([Uint8Array.from([65])]);
  });

  it("accepts a normal exit whose process group disappears during the bounded reap grace", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterClose = true;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    host.children[0]?.complete(0);
    clock.advanceBy(20);
    host.groupAlive = false;
    clock.advanceBy(10);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      processControlFailed: false,
    });
    expect(host.groupKills).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("kills and rejects a descendant that outlives the bounded normal-exit grace", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterClose = true;
    const outcomePromise = superviseProcess(
      SPECIFICATION,
      new Uint8Array(),
      { ...LIMITS, wallTimeMs: 500, normalExitReapGraceMs: 250 },
      { clock, processHost: host },
    );

    host.children[0]?.complete(0);
    clock.advanceBy(249);
    expect(host.groupKills).toEqual([]);
    clock.advanceBy(1);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      processControlFailed: true,
    });
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
    expect(host.groupAlive).toBe(false);
  });

  it("fails closed when process-group liveness becomes unobservable during reap grace", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterClose = true;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    host.children[0]?.complete(0);
    host.groupLivenessError = new Error("EPERM");
    clock.advanceBy(10);
    host.groupLivenessError = undefined;
    clock.advanceBy(10);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      processControlFailed: true,
    });
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
  });

  it("lets the wall-time watchdog preempt normal-exit reap grace", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterClose = true;
    const outcomePromise = superviseProcess(
      SPECIFICATION,
      new Uint8Array(),
      { ...LIMITS, wallTimeMs: 5, normalExitReapGraceMs: 250 },
      { clock, processHost: host },
    );

    host.children[0]?.complete(0);
    clock.advanceBy(5);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      processControlFailed: false,
    });
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
  });

  it("accepts a leaks-profile exit that reaps within the 250 ms hard cap", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterClose = true;
    const outcomePromise = superviseProcess(
      SPECIFICATION,
      new Uint8Array(),
      { ...LIMITS, wallTimeMs: 500, normalExitReapGraceMs: 250 },
      { clock, processHost: host },
    );

    host.children[0]?.complete(0);
    clock.advanceBy(200);
    host.groupAlive = false;
    clock.advanceBy(10);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      processControlFailed: false,
    });
    expect(host.groupKills).toEqual([]);
  });

  it("rejects a process profile that requests more than the 250 ms hard cap", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();

    await expect(
      superviseProcess(
        SPECIFICATION,
        new Uint8Array(),
        { ...LIMITS, normalExitReapGraceMs: 251 },
        { clock, processHost: host },
      ),
    ).rejects.toThrow(/0 到 250 ms/u);
    expect(host.children).toEqual([]);
  });

  it("fails closed when the RSS monitor errors", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.rssError = new Error("ps unavailable");
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(10);
    await flushAsyncWork();
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "rss-monitor-error",
    });
    expect(host.groupKills).toHaveLength(1);
  });

  it("kills the process group when aggregate RSS exceeds the limit", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.rssBytes = 1_001;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(10);
    await flushAsyncWork();
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "rss-limit",
      peakRssBytes: 1_001,
      peakProcessCount: 1,
    });
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
  });

  it("kills the process group when the same resource sample exceeds the process limit", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.processCount = 65;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(10);
    await flushAsyncWork();
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-count-limit",
      processControlFailed: false,
      peakProcessCount: 65,
    });
    expect(host.resourceSamples).toEqual([4_242]);
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
  });

  it("retains independent RSS and process-count peaks across valid samples", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    host.rssBytes = 320;
    host.processCount = 4;
    clock.advanceBy(10);
    await flushAsyncWork();
    host.rssBytes = 760;
    host.processCount = 2;
    clock.advanceBy(10);
    await flushAsyncWork();
    host.rssBytes = 180;
    host.processCount = 3;
    clock.advanceBy(10);
    await flushAsyncWork();
    host.children[0]?.complete(0);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      peakRssBytes: 760,
      peakProcessCount: 4,
    });
  });

  it("fails closed instead of publishing a malformed resource sample", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.rssBytes = 1.5;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(10);
    await flushAsyncWork();
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "rss-monitor-error",
      peakRssBytes: 0,
      peakProcessCount: 0,
    });
    expect(host.groupKills).toHaveLength(1);
  });

  it("preserves invalid UTF-8 bytes instead of replacing them", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);

    host.children[0]?.emitStdout(invalidUtf8);
    host.children[0]?.complete(0);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "process-exit",
      stdout: invalidUtf8,
    });
  });

  it("records process-group control failure and falls back to the child", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.killError = new Error("EPERM");
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(100);
    host.groupAlive = false;
    host.children[0]?.emitClose(null, "SIGKILL");

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      processControlFailed: true,
    });
    expect(host.children[0]?.killSignals).toEqual(["SIGKILL"]);
  });

  it("keeps watchdogs active when the leader exits but a descendant inherits stdio", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });
    let settled = false;
    void outcomePromise.then(() => {
      settled = true;
    });

    host.children[0]?.emitExit(0);
    await flushAsyncWork();
    expect(settled).toBe(false);

    clock.advanceBy(100);
    expect(host.groupKills).toEqual([{ processGroupId: 4_242, signal: "SIGKILL" }]);
    expect(settled).toBe(false);

    host.children[0]?.emitClose(null, "SIGKILL");
    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      processControlFailed: false,
    });
  });

  it("retains the stdin error listener while waiting for close after termination", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    const outcomePromise = superviseProcess(SPECIFICATION, Uint8Array.from([65]), LIMITS, {
      clock,
      processHost: host,
    });
    const child = host.children[0];

    clock.advanceBy(100);
    expect(child?.listenerCount("input-error")).toBe(1);
    child?.emitInputError(new Error("late EPIPE"));
    expect(host.groupKills).toHaveLength(1);

    child?.emitClose(null, "SIGKILL");
    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      processControlFailed: false,
    });
    expect(child?.listenerCount("input-error")).toBe(0);
  });

  it("bounds the close/reap wait and reports unconfirmed group termination", async () => {
    const clock = new FakeClock();
    const host = new FakeProcessHost();
    host.keepGroupAliveAfterKill = true;
    const outcomePromise = superviseProcess(SPECIFICATION, new Uint8Array(), LIMITS, {
      clock,
      processHost: host,
    });

    clock.advanceBy(100);
    clock.advanceBy(1_000);

    await expect(outcomePromise).resolves.toMatchObject({
      termination: "wall-time-limit",
      processControlFailed: true,
    });
    expect(host.groupLivenessChecks.length).toBeGreaterThan(1);
  });
});
