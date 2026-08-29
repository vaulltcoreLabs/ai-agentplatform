/**
 * Phase 4.6 — shared adapter conformance suite.
 *
 * ONE semantic test-suite executed against EVERY SharedBackend adapter:
 *
 *   describeSharedBackendConformance({ name, create, createSharingPeer?, dispose })
 *
 * Tests verify SEMANTICS (the `SharedBackend` contract from
 * `@vaulltcore/workflow`), never implementation details:
 *   - CAS create/update/conflict/stale-rejection
 *   - append completeness and ordering
 *   - incr as atomic fetch-and-add
 *   - get / del / keys prefix semantics
 *
 * When a factory supplies `createSharingPeer` (an INDEPENDENT connection over
 * the same durable state), the distributed section also runs: cross-connection
 * CAS races, concurrent appends, and unique sequence allocation. This is what
 * separates "two objects" from "two workers".
 */

import { describe, expect, it } from "bun:test";
import { CAS_ABSENT, type SharedBackend } from "@vaulltcore/workflow";

export interface BackendFactory {
  readonly name: string;
  /** Create a backend on empty durable state. */
  create(): Promise<SharedBackend> | SharedBackend;
  /**
   * Create TWO INDEPENDENT connections sharing the same durable state.
   * Omit for single-process backends (the distributed section is skipped).
   */
  createPair?():
    | Promise<[SharedBackend, SharedBackend]>
    | [SharedBackend, SharedBackend];
  dispose(): Promise<void> | void;
}

export function describeSharedBackendConformance(f: BackendFactory): void {
  describe(`SharedBackend conformance — ${f.name}`, () => {
    it("CAS: create-on-absent succeeds exactly once", async () => {
      const b = await f.create();
      expect(await b.cas("k", CAS_ABSENT, { v: 1 })).toBe(true);
      // Second create-on-absent must fail — the key now exists.
      expect(await b.cas("k", CAS_ABSENT, { v: 2 })).toBe(false);
      await f.dispose();
    });

    it("CAS: matching expected updates; stale expected rejected", async () => {
      const b = await f.create();
      await b.cas("s", CAS_ABSENT, { rev: 1 });

      const current = (await b.get("s")) as { rev: number };
      expect(await b.cas("s", current, { rev: 2 })).toBe(true);

      // `current` is now stale — this commit must be rejected.
      expect(await b.cas("s", current, { rev: 99 })).toBe(false);
      expect(await b.get("s")).toEqual({ rev: 2 });
      await f.dispose();
    });

    it("CAS: deep-equality on structurally identical values", async () => {
      const b = await f.create();
      await b.cas("d", CAS_ABSENT, { a: 1, b: { c: [1, 2] } });
      // Freshly-constructed equal object must match (JSON round-trip safe).
      expect(await b.cas("d", { a: 1, b: { c: [1, 2] } }, { ok: true })).toBe(
        true,
      );
      expect(await b.get("d")).toEqual({ ok: true });
      await f.dispose();
    });

    it("append: preserves completeness under concurrency", async () => {
      const b = await f.create();
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => b.append("events", { i })),
      );
      const list = (await b.list("events")) as Array<{ i: number }>;
      expect(list).toHaveLength(50); // no lost events
      const seen = new Set(list.map((e) => e.i));
      expect(seen.size).toBe(50); // no duplicated events
      await f.dispose();
    });

    it("incr: atomic fetch-and-add with no lost updates", async () => {
      const b = await f.create();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => b.incr("seq")),
      );
      expect(new Set(results).size).toBe(50); // every caller got a unique value
      expect(await b.get("seq")).toBe(50);
      await f.dispose();
    });

    it("get/del/keys: prefix scan and deletion", async () => {
      const b = await f.create();
      await b.cas("tenant_a::job1", CAS_ABSENT, { x: 1 });
      await b.cas("tenant_a::job2", CAS_ABSENT, { x: 2 });
      await b.cas("tenant_b::job3", CAS_ABSENT, { x: 3 });
      expect((await b.keys("tenant_a::")).sort()).toEqual([
        "tenant_a::job1",
        "tenant_a::job2",
      ]);
      await b.del("tenant_a::job1");
      expect(await b.get("tenant_a::job1")).toBeUndefined();
      expect(await b.get("tenant_a::job2")).toEqual({ x: 2 });
      await f.dispose();
    });

    describe("distributed — independent connections over shared state", () => {
      it("CAS race across connections → exactly one winner", async () => {
        if (!f.createPair) return;
        const [a, b] = await f.createPair();

        const [wa, wb] = await Promise.all([
          a.cas("race", CAS_ABSENT, { who: "a" }),
          b.cas("race", CAS_ABSENT, { who: "b" }),
        ]);
        expect([wa, wb].filter(Boolean)).toHaveLength(1);
        expect(await a.get("race")).toEqual(await b.get("race"));
        await f.dispose();
      });

      it("concurrent append across connections → complete, no torn reads", async () => {
        if (!f.createPair) return;
        const [a, b] = await f.createPair();

        await Promise.all([
          ...Array.from({ length: 25 }, (_, i) =>
            a.append("log", { src: "a", i }),
          ),
          ...Array.from({ length: 25 }, (_, i) =>
            b.append("log", { src: "b", i }),
          ),
        ]);
        const list = (await a.list("log")) as Array<{ src: string; i: number }>;
        expect(list).toHaveLength(50);
        for (const e of list) {
          expect(typeof e.i).toBe("number");
          expect(["a", "b"]).toContain(e.src);
        }
        await f.dispose();
      });

      it("concurrent incr across connections → unique allocation", async () => {
        if (!f.createPair) return;
        const [a, b] = await f.createPair();

        const values = await Promise.all([
          ...Array.from({ length: 25 }, () => a.incr("n")),
          ...Array.from({ length: 25 }, () => b.incr("n")),
        ]);
        expect(new Set(values).size).toBe(50);
        expect(await b.get("n")).toBe(50);
        await f.dispose();
      });
    });
  });
}
