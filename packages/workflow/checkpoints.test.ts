import { describe, expect, it, beforeEach } from "bun:test";
import {
  InMemoryCheckpointStore,
  InMemoryEventStore,
  TestClock,
} from "./stores";
import {
  createCheckpoint,
  deriveResumePoint,
  mergeEvidence,
  isLatestCheckpoint,
  highestAttempt,
} from "./checkpoints";
import { encodeCursor, decodeCursor, applyCursor } from "./streaming";
import type { Checkpoint, DurableEvent } from "./model";

const RUN_ID = "drun_testrun1234567890123456789012";
const STEP_ID = "dstep_teststep123456789012345678901";
const TASK_ID = "dtask_testtask12345678901234567890";

function makeCheckpoint(
  seq: number,
  attempt = 1,
  evidence: string[] = [],
): Checkpoint {
  return createCheckpoint(
    STEP_ID,
    seq,
    { step: seq },
    evidence,
    attempt,
    1000 + seq * 100,
    RUN_ID,
    TASK_ID,
  );
}

describe("checkpoints — deriveResumePoint", () => {
  it("returns null for empty list", () => {
    expect(deriveResumePoint([])).toBeNull();
  });

  it("returns the only checkpoint", () => {
    const cp = makeCheckpoint(0);
    expect(deriveResumePoint([cp])).toEqual(cp);
  });

  it("returns the highest-sequence checkpoint", () => {
    const checkpoints = [
      makeCheckpoint(0),
      makeCheckpoint(2),
      makeCheckpoint(1),
    ];
    const latest = deriveResumePoint(checkpoints)!;
    expect(latest.sequence).toBe(2);
  });

  it("handles out-of-order input", () => {
    const checkpoints = [
      makeCheckpoint(5),
      makeCheckpoint(1),
      makeCheckpoint(3),
    ];
    const latest = deriveResumePoint(checkpoints)!;
    expect(latest.sequence).toBe(5);
  });
});

describe("checkpoints — isLatestCheckpoint", () => {
  it("returns true for the highest sequence", () => {
    const checkpoints = [
      makeCheckpoint(0),
      makeCheckpoint(1),
      makeCheckpoint(2),
    ];
    expect(isLatestCheckpoint(checkpoints[2]!, checkpoints)).toBe(true);
    expect(isLatestCheckpoint(checkpoints[0]!, checkpoints)).toBe(false);
  });

  it("returns true for the only checkpoint", () => {
    const cp = makeCheckpoint(0);
    expect(isLatestCheckpoint(cp, [cp])).toBe(true);
  });
});

describe("checkpoints — mergeEvidence", () => {
  it("deduplicates evidence refs", () => {
    const cps = [
      makeCheckpoint(0, 1, ["a", "b"]),
      makeCheckpoint(1, 2, ["b", "c"]),
    ];
    const merged = mergeEvidence(cps);
    expect(merged).toEqual(["a", "b", "c"]);
  });

  it("returns empty for no checkpoints", () => {
    expect(mergeEvidence([])).toEqual([]);
  });
});

describe("checkpoints — highestAttempt", () => {
  it("returns the highest attempt", () => {
    const cps = [
      makeCheckpoint(0, 1),
      makeCheckpoint(1, 2),
      makeCheckpoint(2, 1),
    ];
    expect(highestAttempt(cps)).toBe(2);
  });

  it("returns 0 for empty", () => {
    expect(highestAttempt([])).toBe(0);
  });
});

describe("checkpoints — InMemoryCheckpointStore", () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it("saves and lists checkpoints sorted by sequence", async () => {
    await store.save(makeCheckpoint(2));
    await store.save(makeCheckpoint(0));
    await store.save(makeCheckpoint(1));
    const list = await store.listForStep(STEP_ID);
    expect(list.map((c) => c.sequence)).toEqual([0, 1, 2]);
  });

  it("returns the latest checkpoint", async () => {
    await store.save(makeCheckpoint(0));
    await store.save(makeCheckpoint(3));
    await store.save(makeCheckpoint(1));
    const latest = await store.latestForStep(STEP_ID);
    expect(latest!.sequence).toBe(3);
  });

  it("returns null when no checkpoints", async () => {
    expect(await store.latestForStep(STEP_ID)).toBeNull();
  });

  it("counts checkpoints across steps", async () => {
    const step2 = "dstep_other12345678901234567890123456";
    await store.save(makeCheckpoint(0));
    await store.save(
      createCheckpoint(step2, 0, {}, [], 1, 2000, RUN_ID, TASK_ID),
    );
    expect(store.count()).toBe(2);
  });
});

describe("event store — ordering & idempotency", () => {
  let store: InMemoryEventStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryEventStore(clock);
  });

  const TENANT = "tenant_test";
  const CORRELATION = "corr_test";

  it("assigns monotonic sequences", async () => {
    const e1 = await store.append({
      runId: RUN_ID,
      type: "step.started",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    const e2 = await store.append({
      runId: RUN_ID,
      type: "step.completed",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
  });

  it("isolates sequences per run", async () => {
    const otherRun = "drun_otherrun123456789012345678901234";
    await store.append({
      runId: RUN_ID,
      type: "e1",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: RUN_ID,
      type: "e2",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: otherRun,
      type: "e3",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    expect(store.count(RUN_ID)).toBe(2);
    expect(store.count(otherRun)).toBe(1);
  });

  it("deduplicates on idempotency key", async () => {
    const idem = "idem_testkey123";
    const e1 = await store.append({
      runId: RUN_ID,
      type: "e1",
      payload: { a: 1 },
      idempotencyKey: idem,
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    const e2 = await store.append({
      runId: RUN_ID,
      type: "e1",
      payload: { a: 2 },
      idempotencyKey: idem,
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    expect(e1).toEqual(e2);
    expect(store.count(RUN_ID)).toBe(1);
  });

  it("replays events in sequence order", async () => {
    await store.append({
      runId: RUN_ID,
      type: "e1",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: RUN_ID,
      type: "e2",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: RUN_ID,
      type: "e3",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    const events = await store.replay(RUN_ID, 1);
    expect(events.length).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["e1", "e2", "e3"]);
  });

  it("replays from a sequence offset", async () => {
    await store.append({
      runId: RUN_ID,
      type: "e1",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: RUN_ID,
      type: "e2",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    await store.append({
      runId: RUN_ID,
      type: "e3",
      payload: {},
      tenantId: TENANT,
      correlationId: CORRELATION,
    });
    const events = await store.replay(RUN_ID, 2);
    expect(events.map((e) => e.type)).toEqual(["e2", "e3"]);
  });
});

describe("streaming — cursor", () => {
  it("round-trips a cursor", () => {
    const token = encodeCursor("run_123", 42);
    const decoded = decodeCursor(token)!;
    expect(decoded.runId).toBe("run_123");
    expect(decoded.lastSequence).toBe(42);
  });

  it("returns undefined for invalid token", () => {
    expect(decodeCursor("not-valid-base64!!")).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });

  it("applyCursor filters events after the cursor", () => {
    const events: DurableEvent[] = [
      {
        eventId: "e1",
        runId: "r1",
        sequence: 1,
        type: "t",
        timestamp: 0,
        tenantId: "t",
        correlationId: "c",
        payload: {},
      },
      {
        eventId: "e2",
        runId: "r1",
        sequence: 2,
        type: "t",
        timestamp: 0,
        tenantId: "t",
        correlationId: "c",
        payload: {},
      },
      {
        eventId: "e3",
        runId: "r1",
        sequence: 3,
        type: "t",
        timestamp: 0,
        tenantId: "t",
        correlationId: "c",
        payload: {},
      },
    ];
    const cursor = {
      token: encodeCursor("r1", 1),
      runId: "r1",
      lastSequence: 1,
    };
    const result = applyCursor(events, cursor);
    expect(result.events.length).toBe(2);
    expect(result.events.map((e) => e.sequence)).toEqual([2, 3]);
    expect(result.nextCursor).toBe(encodeCursor("r1", 3));
  });

  it("applyCursor with no cursor returns all events", () => {
    const events: DurableEvent[] = [
      {
        eventId: "e1",
        runId: "r1",
        sequence: 1,
        type: "t",
        timestamp: 0,
        tenantId: "t",
        correlationId: "c",
        payload: {},
      },
    ];
    const result = applyCursor(events, undefined);
    expect(result.events.length).toBe(1);
  });

  it("applyCursor with empty events returns empty nextCursor", () => {
    const result = applyCursor([], undefined);
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe("");
  });
});
