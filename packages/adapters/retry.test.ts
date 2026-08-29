/**
 * Phase 4.6 — failure-model tests (Workstream: retry classification).
 *
 * Proves:
 *  - transient classes (SQLite BUSY, PG serialization/deadlock/connection)
 *    are retried and eventually succeed
 *  - permanent classes (constraint violation, unknown errors) propagate on
 *    the first attempt — no blind retries
 *  - retries are BOUNDED
 */

import { describe, expect, it } from "bun:test";
import { classifyDatabaseError, withDatabaseRetry } from "./retry";

describe("classifyDatabaseError", () => {
  it("classifies SQLite writer contention as transient", () => {
    const err = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    expect(classifyDatabaseError(err)).toBe("transient");
  });

  it("classifies PG serialization failure and deadlock as transient", () => {
    for (const code of ["40001", "40P01", "57P03", "53300"]) {
      const err = Object.assign(new Error("pg error"), { code });
      expect(classifyDatabaseError(err)).toBe("transient");
    }
  });

  it("classifies connection failures as transient", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
      const err = Object.assign(new Error("network"), { code });
      expect(classifyDatabaseError(err)).toBe("transient");
    }
    expect(
      classifyDatabaseError(new Error("Connection terminated unexpectedly")),
    ).toBe("transient");
  });

  it("classifies constraint violations as PERMANENT (caller decides meaning)", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(classifyDatabaseError(err)).toBe("permanent");
  });

  it("defaults unknown errors to permanent (no blind retries)", () => {
    expect(classifyDatabaseError(new Error("something odd"))).toBe("permanent");
    expect(classifyDatabaseError(undefined)).toBe("permanent");
  });
});

describe("withDatabaseRetry", () => {
  it("retries transient failures until success within bounds", async () => {
    let attempts = 0;
    const result = await withDatabaseRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        }
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("propagates permanent errors on the FIRST attempt", async () => {
    let attempts = 0;
    await expect(
      withDatabaseRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error("duplicate"), { code: "23505" });
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow("duplicate");
    expect(attempts).toBe(1);
  });

  it("is bounded — throws after the configured attempt count", async () => {
    let attempts = 0;
    await expect(
      withDatabaseRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error("still busy"), { code: "SQLITE_BUSY" });
        },
        { retries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("still busy");
    expect(attempts).toBe(3);
  });

  it("returns immediately when the operation succeeds first try", async () => {
    let attempts = 0;
    const value = await withDatabaseRetry(async () => {
      attempts++;
      return attempts;
    });
    expect(value).toBe(1);
  });
});
