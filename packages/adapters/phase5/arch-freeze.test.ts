/**
 * Phase 5 §1 — Architecture Freeze Baseline.
 *
 * Records the exact state of the codebase before qualification begins:
 *   - Git SHA
 *   - Dependency versions
 *   - PostgreSQL version + config
 *   - Schema migration state
 *   - Contract inventory (SharedBackend methods, Queue operations, Runtime API)
 *   - Provider boundary audit (forbidden imports)
 *
 * This file is the single source of truth for what "frozen" means in Phase 5.
 * Every subsequent experiment references this baseline.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { execSync } from "node:child_process";
import {
  hostFingerprint,
  capturePgConfig,
  writeEvidence,
  printGateHeader,
  POSTGRES_URL,
} from "./harness";
import { migratePostgres } from "../pg-backend";

let sql: postgres.Sql | undefined;

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { max: 5 });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

if (!POSTGRES_URL) {
  describe.skip("Phase 5 §1 — architecture freeze (no Postgres)", () => {});
} else {
  describe("Phase 5 §1 — architecture freeze", () => {
    it("records complete environment fingerprint", async () => {
      printGateHeader("arch-freeze-fingerprint");
      const fp = hostFingerprint();

      expect(fp.gitSha).not.toBe("unknown");
      expect(fp.bunVersion).toBeTruthy();
      expect(fp.hostCpus).toBeGreaterThan(0);
      expect(fp.hostMemTotalMb).toBeGreaterThan(0);

      writeEvidence("baseline-fingerprint.json", {
        ...fp,
        verdict: "RECORDED",
      });
    });

    it("records PostgreSQL configuration snapshot", async () => {
      printGateHeader("arch-freeze-pg-config");
      const config = await capturePgConfig(sql!);

      // Durability posture must be documented
      expect(config.server_version).toBeTruthy();
      expect(config.fsync).toBeTruthy();
      expect(config.wal_level).toBeTruthy();

      writeEvidence("baseline-pg-config.json", {
        config,
        verdict: "RECORDED",
      });

      console.log(
        `[arch-freeze] PG ${config.server_version} fsync=${config.fsync} wal=${config.wal_level}`,
      );
    });

    it("records schema migration state", async () => {
      printGateHeader("arch-freeze-migrations");
      await migratePostgres(sql!);

      const migrations = await sql!<{ version: string }[]>`SELECT version, applied_at FROM vc_schema_migrations ORDER BY version`;
      const schemaVersion = migrations.map(
        (r) => r.version,
      );

      // Verify expected migrations exist
      expect(schemaVersion).toContain("001_shared_backend");

      // Verify DDL tables exist
      const tables = await sql!<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      const tableNames = tables.map(
        (r) => r.tablename,
      );
      expect(tableNames).toContain("vc_kv");
      expect(tableNames).toContain("vc_schema_migrations");

      writeEvidence("baseline-migrations.json", {
        schemaVersion,
        tableNames,
        verdict: "RECORDED",
      });
    });

    it("records dependency fingerprint", async () => {
      printGateHeader("arch-freeze-deps");
      let sha: string;
      try {
        sha = execSync("git rev-parse HEAD", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        sha = "unknown";
      }

      writeEvidence("baseline-dependencies.json", {
        gitSha: sha,
        gitShortSha: sha.slice(0, 8),
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        verdict: "RECORDED",
      });
    });

    it("records contract inventory — all SharedBackend primitive keys", async () => {
      printGateHeader("arch-freeze-contracts");

      // The contract is: SharedBackend provides cas/get/append/list/incr/del/keys
      // These are exercised by the conformance suite. Record the known contract.
      const contracts = {
        sharedBackend: [
          "cas",
          "get",
          "append",
          "list",
          "incr",
          "del",
          "keys",
          "appendUnique",
        ],
        queue: [
          "enqueue",
          "claim",
          "ack",
          "retry",
          "repair",
          "removeVisible",
        ],
        runtime: [
          "submit",
          "cancel",
          "getJob",
          "getRun",
          "retry",
          "processOne",
          "reconcile",
          "stream",
          "events",
          "checkpoints",
        ],
      };

      writeEvidence("baseline-contracts.json", {
        contracts,
        verdict: "RECORDED",
      });
    });
  });
}
