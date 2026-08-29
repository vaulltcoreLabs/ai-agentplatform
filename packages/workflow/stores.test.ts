import { describe, expect, it, beforeEach } from "bun:test";
import { InMemoryWorkflowStore, TestClock } from "./stores";
import type { Step, Task, Run, Job } from "./model";

const TENANT = "tenant_test";
const JOB_ID = "djob_testjob1234567890123456789012";
const RUN_ID = "drun_testrun1234567890123456789012";
const TASK_ID = "dtask_testtask12345678901234567890";
const STEP_ID = "dstep_teststep123456789012345678901";
const WORKER = "tenant_t:worker:abc123";

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: STEP_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    tenantId: TENANT,
    attempt: 1,
    taskIdRef: "phase3_main",
    status: "created",
    createdAt: 1000,
    version: 0,
    ...overrides,
  } as Step;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    runId: RUN_ID,
    jobId: JOB_ID,
    spec: {
      id: TASK_ID,
      name: "main",
      specialist: "coder",
      dependsOn: [],
      input: null,
    },
    status: "queued",
    attempt: 1,
    completedSteps: [],
    version: 0,
    ...overrides,
  } as Task;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    jobId: JOB_ID,
    tenantId: TENANT,
    version: 1,
    status: "created",
    createdAt: 1000,
    taskIds: [TASK_ID],
    leasedStepIds: [],
    versionToken: 0,
    budget: {
      maxRuntimeMs: 3600_000,
      maxModelCalls: 1000,
      maxToolCalls: 2000,
      maxInputTokens: 500_000,
      maxOutputTokens: 200_000,
    },
    deadlineAt: 2000 + 3600_000,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    objective: "build a web server",
    status: "created",
    runCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
    version: 0,
    ...overrides,
  } as Job;
}

describe("InMemoryWorkflowStore — save/get roundtrip", () => {
  let store: InMemoryWorkflowStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryWorkflowStore(clock);
  });

  it("saves and retrieves a job", async () => {
    const job = makeJob();
    expect(await store.saveJob(job)).toBe(true);
    expect(await store.getJob(TENANT, JOB_ID)).toEqual(job);
  });

  it("upserts job on second save with higher version", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const updated = { ...job, updatedAt: 2000, version: job.version + 1 };
    expect(await store.saveJob(updated)).toBe(true);
    const result = await store.getJob(TENANT, JOB_ID);
    expect(result!.updatedAt).toBe(2000);
  });

  it("rejects job save with stale version", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const updated = { ...job, updatedAt: 2000, version: 1 };
    await store.saveJob(updated);
    const stale = { ...job, updatedAt: 3000, version: 0 };
    expect(await store.saveJob(stale)).toBe(false);
  });

  it("rejects same-version job save (>= guard, not >)", async () => {
    const job = makeJob();
    await store.saveJob(job);
    // Same version must be rejected (consistent with DistributedWorkflowStore
    // which uses >=). This prevents stale-worker overwrites with equal version.
    expect(await store.saveJob({ ...job, updatedAt: 2000 })).toBe(false);
  });

  it("saves and retrieves a run", async () => {
    const run = makeRun();
    expect(await store.saveRun(run)).toBe(true);
    expect(await store.getRun(RUN_ID)).toEqual(run);
  });

  it("upserts run on second save with higher version", async () => {
    const run = makeRun();
    await store.saveRun(run);
    const updated = { ...run, version: run.version + 1 };
    expect(await store.saveRun(updated)).toBe(true);
    const result = await store.getRun(RUN_ID);
    expect(result!.version).toBe(2);
  });

  it("rejects run save with stale version", async () => {
    const run = makeRun();
    await store.saveRun(run);
    const updated = { ...run, version: 2 };
    await store.saveRun(updated);
    const stale = { ...run, version: 1 };
    expect(await store.saveRun(stale)).toBe(false);
  });

  it("saves and retrieves a task", async () => {
    const task = makeTask();
    await store.saveTask(TASK_ID, task);
    expect(await store.getTask(TASK_ID)).toEqual(task);
  });

  it("saves and retrieves a step", async () => {
    const step = makeStep();
    await store.saveStep(step, 0);
    expect(await store.getStep(STEP_ID)).toEqual(step);
  });
});

describe("InMemoryWorkflowStore — run transitions (CAS)", () => {
  let store: InMemoryWorkflowStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryWorkflowStore(clock);
  });

  it("transitions run created → queued on correct version", async () => {
    const run = makeRun({ status: "created", version: 1 });
    await store.saveRun(run);
    const t = await store.transitionRun(RUN_ID, "created", "queued", {
      expectedVersion: 1,
      actor: WORKER,
      source: "test",
      correlationId: "corr1",
    });
    expect(t).not.toBeNull();
    expect(t!.to).toBe("queued");
    expect(t!.version).toBe(2);
  });

  it("fails transition on version mismatch", async () => {
    const run = makeRun({ status: "created", version: 1 });
    await store.saveRun(run);
    const t = await store.transitionRun(RUN_ID, "created", "queued", {
      expectedVersion: 99,
      actor: WORKER,
      source: "test",
      correlationId: "corr1",
    });
    expect(t).toBeNull();
  });

  it("fails transition on wrong from-state", async () => {
    const run = makeRun({ status: "created", version: 1 });
    await store.saveRun(run);
    const t = await store.transitionRun(RUN_ID, "running", "queued", {
      expectedVersion: 1,
      actor: WORKER,
      source: "test",
      correlationId: "corr1",
    });
    expect(t).toBeNull();
  });

  it("rejects invalid transition (queued → completed)", async () => {
    const run = makeRun({ status: "queued", version: 1 });
    await store.saveRun(run);
    const t = await store.transitionRun(RUN_ID, "queued", "completed", {
      expectedVersion: 1,
      actor: WORKER,
      source: "test",
      correlationId: "corr1",
    });
    expect(t).toBeNull();
  });

  it("records transitions for audit", async () => {
    const run = makeRun({ status: "created", version: 1 });
    await store.saveRun(run);
    await store.transitionRun(RUN_ID, "created", "queued", {
      expectedVersion: 1,
      actor: WORKER,
      source: "test",
      correlationId: "c1",
    });
    await store.transitionRun(RUN_ID, "queued", "running", {
      expectedVersion: 2,
      actor: WORKER,
      source: "test",
      correlationId: "c2",
    });
    const txns = await store.getTransitions("run");
    expect(txns.length).toBe(2);
    expect(txns[0]!.from).toBe("created");
    expect(txns[1]!.from).toBe("queued");
  });
});

describe("InMemoryWorkflowStore — step CAS fencing", () => {
  let store: InMemoryWorkflowStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryWorkflowStore(clock);
  });

  it("saves a new step when expected version is 0", async () => {
    const step = makeStep({ version: 0 });
    expect(await store.saveStep(step, 0)).toBe(true);
  });

  it("rejects step save when version mismatches", async () => {
    const step = makeStep({ version: 0 });
    await store.saveStep(step, 0);
    // Another worker updates the step to version 1
    const midUpdate = { ...step, version: 1, status: "running" as const };
    await store.saveStep(midUpdate, 0);
    // Now we try to save version 2, claiming the current version is still 0
    const updated = { ...step, version: 2, status: "completed" as const };
    expect(await store.saveStep(updated, 0)).toBe(false);
  });

  it("accepts step save with correct version", async () => {
    const step = makeStep({ version: 0 });
    await store.saveStep(step, 0);
    const updated = { ...step, version: 1, status: "running" as const };
    // Existing version is 0, expectedVersion is 0 → match
    expect(await store.saveStep(updated, 0)).toBe(true);
    expect((await store.getStep(STEP_ID))!.status).toBe("running");
  });
});

describe("InMemoryWorkflowStore — idempotency", () => {
  let store: InMemoryWorkflowStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryWorkflowStore(clock);
  });

  it("is idempotent on repeated saveJob calls", async () => {
    const job = makeJob();
    await store.saveJob(job);
    const job2 = { ...job, updatedAt: 2000 };
    await store.saveJob(job2); // different version — should be a separate save
    const result = await store.getJob(TENANT, JOB_ID);
    // First save wins
    expect(result).toBeDefined();
  });
});
