import { describe, expect, it, beforeEach } from "bun:test";
import { InMemoryTaskLeaseStore, TestClock } from "./stores";
import {
  verifyFencing,
  isLeaseValid,
  shouldRenew,
  refreshedLease,
  computeLeaseTtl,
  DEFAULT_LEASE_CONFIG,
} from "./leases";
import type { Lease } from "./model";

const STEP_ID = "dstep_teststep123456789012345678901";
const WORKER_A = "tenant_t:worker:aaa";
const WORKER_B = "tenant_t:worker:bbb";

function makeLease(overrides: Partial<Lease> = {}): Lease {
  const now = 1000;
  return {
    id: "lease-1",
    stepId: STEP_ID,
    owner: WORKER_A,
    attempt: 1,
    expiresAt: now + 30_000,
    heartbeatAt: now,
    version: 1,
    createdAt: now,
    revokedAt: null,
    ...overrides,
  };
}

describe("InMemoryTaskLeaseStore — claim / revoke", () => {
  let store: InMemoryTaskLeaseStore;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    store = new InMemoryTaskLeaseStore(clock);
  });

  it("claims a lease for a worker", async () => {
    const lease = await store.claim(STEP_ID, WORKER_A, 30_000);
    expect(lease).not.toBeNull();
    expect(lease!.owner).toBe(WORKER_A);
    expect(lease!.stepId).toBe(STEP_ID);
    expect(lease!.attempt).toBe(1);
  });

  it("prevents double-claim while lease is active", async () => {
    await store.claim(STEP_ID, WORKER_A, 30_000);
    const lease = await store.claim(STEP_ID, WORKER_B, 30_000);
    expect(lease).toBeNull();
  });

  it("allows claim after lease expires", async () => {
    await store.claim(STEP_ID, WORKER_A, 1_000);
    clock.advance(1_500); // expire the lease
    const lease = await store.claim(STEP_ID, WORKER_B, 30_000);
    expect(lease).not.toBeNull();
    expect(lease!.owner).toBe(WORKER_B);
    expect(lease!.attempt).toBe(2); // attempt increments
  });

  it("can revoke a lease", async () => {
    const lease = await store.claim(STEP_ID, WORKER_A, 30_000);
    await store.revoke(lease!.id, WORKER_A);
    expect(await store.getLease(STEP_ID)).toBeNull();
  });

  it("can renew a lease you own", async () => {
    const lease = await store.claim(STEP_ID, WORKER_A, 5_000);
    clock.advance(3_000);
    await store.renew(lease!.id, WORKER_A, 30_000);
    const refreshed = await store.getLease(STEP_ID);
    expect(refreshed!.expiresAt).toBe(34_000); // 4000 + 30000
    expect(refreshed!.version).toBe(2);
  });

  it("cannot renew a lease owned by another worker", async () => {
    const lease = await store.claim(STEP_ID, WORKER_A, 30_000);
    expect(await store.renew(lease!.id, WORKER_B, 30_000)).toBe(false);
  });

  it("finds expired leases", async () => {
    await store.claim(STEP_ID, WORKER_A, 1_000);
    clock.advance(1_500);
    const expired = await store.getExpiredLeases(clock.now());
    expect(expired.length).toBe(1);
    expect(expired[0]!.stepId).toBe(STEP_ID);
  });
});

describe("leases — verifyFencing", () => {
  const now = 1000;

  it("accepts a valid lease", () => {
    const lease = makeLease();
    expect(verifyFencing(lease, WORKER_A, "lease-1", 1, now)).toBe(true);
  });

  it("rejects wrong owner", () => {
    expect(verifyFencing(makeLease(), WORKER_B, "lease-1", 1, now)).toBe(false);
  });

  it("rejects wrong lease id", () => {
    expect(verifyFencing(makeLease(), WORKER_A, "lease-999", 1, now)).toBe(
      false,
    );
  });

  it("rejects stale version (fencing)", () => {
    expect(verifyFencing(makeLease(), WORKER_A, "lease-1", 99, now)).toBe(
      false,
    );
  });

  it("rejects expired lease", () => {
    const lease = makeLease({ expiresAt: now });
    expect(verifyFencing(lease, WORKER_A, "lease-1", 1, now)).toBe(false);
  });

  it("rejects revoked lease", () => {
    const lease = makeLease({ revokedAt: 2000 });
    expect(verifyFencing(lease, WORKER_A, "lease-1", 1, now)).toBe(false);
  });

  it("rejects null lease", () => {
    expect(verifyFencing(null, WORKER_A, "lease-1", 1, now)).toBe(false);
  });
});

describe("leases — helpers", () => {
  it("isLeaseValid returns true for active lease", () => {
    const lease = makeLease({ expiresAt: 5000, revokedAt: null });
    expect(isLeaseValid(lease, 1000)).toBe(true);
  });

  it("isLeaseValid returns false for expired lease", () => {
    expect(isLeaseValid(makeLease({ expiresAt: 500 }), 1000)).toBe(false);
  });

  it("shouldRenew triggers when lease nears expiry", () => {
    const lease = makeLease({ expiresAt: 1000 + 4_000 });
    // 4s left, heartbeat interval is 5s → should renew
    expect(shouldRenew(lease, 1000, DEFAULT_LEASE_CONFIG)).toBe(true);
  });

  it("shouldRenew does not trigger when lease is fresh", () => {
    const lease = makeLease({ expiresAt: 1000 + 25_000 });
    expect(shouldRenew(lease, 1000, DEFAULT_LEASE_CONFIG)).toBe(false);
  });

  it("refreshedLease bumps version and extends expiry", () => {
    const lease = makeLease({ version: 1, expiresAt: 5000 });
    const refreshed = refreshedLease(lease, 30_000, 10_000);
    expect(refreshed.version).toBe(2);
    expect(refreshed.expiresAt).toBe(40_000);
    expect(refreshed.heartbeatAt).toBe(10_000);
  });

  it("computeLeaseTtl caps at remaining deadline", () => {
    // 10s until deadline, config ttl is 30s → use 10s
    expect(computeLeaseTtl(11_000, 1000, DEFAULT_LEASE_CONFIG)).toBe(10_000);
  });

  it("computeLeaseTtl uses config when no deadline", () => {
    expect(computeLeaseTtl(undefined, 1000, DEFAULT_LEASE_CONFIG)).toBe(30_000);
  });
});
