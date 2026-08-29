import { describe, expect, it } from "bun:test";
import {
  MemoryEventLog,
  INTELLIGENCE_EVENT_VERSION,
  isIntelligenceEvent,
} from "./events";
import { newCorrelation } from "./correlation";
import { createJobId } from "./ids";

describe("events", () => {
  it("appends and replays events for a job", async () => {
    const log = new MemoryEventLog();
    const jobId = createJobId("tenant-1", "objective");
    const correlation = newCorrelation("tenant-1", jobId);

    const e1 = await log.append({
      type: "job.created",
      objective: "test",
      jobId,
      tenantId: "tenant-1",
      correlation,
    });

    const e2 = await log.append({
      type: "job.planned",
      plan: { taskIds: [], specialistByTask: [] },
      tenantId: "tenant-1",
      correlation,
    });

    expect(e1.sequence).toBe(0);
    expect(e2.sequence).toBe(1);
    expect(e1.version).toBe(INTELLIGENCE_EVENT_VERSION);
    expect(e1.timestamp).toBeGreaterThan(0);
    expect(e2.timestamp).toBeGreaterThanOrEqual(e1.timestamp);

    const replay = await log.replay(jobId);
    expect(replay.length).toBe(2);
    expect(replay[0]!.type).toBe("job.created");
    expect(replay[1]!.type).toBe("job.planned");
  });

  it("count returns correct counts", async () => {
    const log = new MemoryEventLog();
    const jobId = createJobId("t", "o");
    const correlation = newCorrelation("t", jobId);
    const jobId2 = createJobId("t", "o2");
    const correlation2 = newCorrelation("t", jobId2);
    await log.append({
      type: "job.created",
      objective: "o",
      jobId,
      tenantId: "t",
      correlation,
    });
    await log.append({
      type: "job.created",
      objective: "o2",
      jobId: jobId2,
      tenantId: "t",
      correlation: correlation2,
    });

    expect(log.count(jobId)).toBe(1);
    expect(log.count(jobId2)).toBe(1);
    expect(log.count()).toBe(2);
  });

  it("replay returns empty for unknown job", async () => {
    const log = new MemoryEventLog();
    const result = await log.replay("nonexistent");
    expect(result).toEqual([]);
  });

  it("events are immutable (frozen)", async () => {
    const log = new MemoryEventLog();
    const jobId = createJobId("t", "o");
    const correlation = newCorrelation("t", jobId);
    const e = await log.append({
      type: "job.created",
      objective: "o",
      jobId,
      tenantId: "t",
      correlation,
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { type: string }).type = "tampered";
    }).toThrow();
  });

  it("isIntelligenceEvent validates structure", () => {
    expect(isIntelligenceEvent(null)).toBe(false);
    expect(isIntelligenceEvent("string")).toBe(false);
    expect(
      isIntelligenceEvent({
        version: "v1",
        type: "job.created",
        tenantId: "t",
      }),
    ).toBe(true);
    expect(
      isIntelligenceEvent({ version: "wrong", type: "x", tenantId: "t" }),
    ).toBe(false);
  });

  it("replay returns defensive copies", async () => {
    const log = new MemoryEventLog();
    const jobId = createJobId("t", "o");
    const correlation = newCorrelation("t", jobId);
    await log.append({
      type: "job.created",
      objective: "o",
      jobId,
      tenantId: "t",
      correlation,
    });
    const a = await log.replay(jobId);
    const b = await log.replay(jobId);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
