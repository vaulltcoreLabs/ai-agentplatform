/**
 * Phase 5 — ObjectStore contract unit tests.
 *
 * These run against the explicitly-classified TEST-ONLY MemoryObjectStore and
 * verify CONTRACT SEMANTICS (idempotent delete, head/get consistency, key
 * construction safety, presign clamping). Real-provider behavior is covered by
 * the R2 real-infrastructure gate, which SKIPS without credentials (§42).
 */

import { describe, expect, it } from "bun:test";
import {
  artifactObjectKey,
  MemoryObjectStore,
  MAX_PRESIGN_EXPIRY_SEC,
  MIN_PRESIGN_EXPIRY_SEC,
} from "./index";

describe("artifactObjectKey — tenant scoping", () => {
  it("builds the canonical tenant-scoped path", () => {
    expect(
      artifactObjectKey({
        tenantId: "t_a",
        runId: "r_1",
        artifactId: "a_1",
      }),
    ).toBe("tenants/t_a/runs/r_1/artifacts/a_1");
  });

  it("rejects traversal and empty segments", () => {
    for (const tenantId of ["", "../t_b", "a/b"]) {
      expect(() =>
        artifactObjectKey({ tenantId, runId: "r", artifactId: "a" }),
      ).toThrow();
    }
    expect(() =>
      artifactObjectKey({ tenantId: "t", runId: "..", artifactId: "a" }),
    ).toThrow();
    expect(() =>
      artifactObjectKey({ tenantId: "t", runId: "r", artifactId: "" }),
    ).toThrow();
  });
});

describe("MemoryObjectStore — contract semantics", () => {
  it("put → head → get round-trips bytes and metadata", async () => {
    const store = new MemoryObjectStore();
    const body = new TextEncoder().encode("hello vaulltcore");
    await store.put({
      key: "tenants/t/runs/r/artifacts/a",
      body,
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    const head = await store.head("tenants/t/runs/r/artifacts/a");
    expect(head?.byteSize).toBe(body.byteLength);
    expect(head?.contentType).toBe("text/plain");
    const got = await store.get("tenants/t/runs/r/artifacts/a");
    expect(new TextDecoder().decode(got!.body)).toBe("hello vaulltcore");
    expect(got!.metadata?.sha256).toBe("abc");
  });

  it("get/head of a missing key returns null (not throw)", async () => {
    const store = new MemoryObjectStore();
    expect(await store.get("nope")).toBeNull();
    expect(await store.head("nope")).toBeNull();
    expect(await store.exists("nope")).toBe(false);
  });

  it("delete is idempotent; delete then get returns null", async () => {
    const store = new MemoryObjectStore();
    await store.put({ key: "k", body: "x" });
    await store.delete("k");
    await store.delete("k"); // second delete must succeed
    expect(await store.exists("k")).toBe(false);
    expect(await store.get("k")).toBeNull();
  });

  it("failure hooks inject exactly-once failures", async () => {
    const store = new MemoryObjectStore();
    store.failures.failPutOnce = true;
    await expect(store.put({ key: "k", body: "x" })).rejects.toThrow(
      "injected put failure",
    );
    // hook consumed — retry succeeds
    await expect(store.put({ key: "k", body: "x" })).resolves.toBeDefined();
  });

  it("presign expirations clamp into [30s, 900s]", async () => {
    const store = new MemoryObjectStore();
    const lo = await store.createDownloadUrl({ key: "k", expiresInSec: 1 });
    const hi = await store.createUploadUrl({
      key: "k",
      contentType: "application/octet-stream",
      expiresInSec: 999_999,
    });
    expect(lo.expiresInSec).toBe(MIN_PRESIGN_EXPIRY_SEC);
    expect(hi.expiresInSec).toBe(MAX_PRESIGN_EXPIRY_SEC);
  });
});
