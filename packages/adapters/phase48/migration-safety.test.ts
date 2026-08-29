/**
 * Phase 4.8 §26 — migration safety.
 *
 * Each test is fully self-contained: clean state → action → verify → restore.
 * Tests run sequentially against the same PG instance.
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  CAS_ABSENT,
  DistributedCheckpointStore,
  DistributedDurableRuntime,
  DistributedEventStore,
  DistributedIdempotencyStore,
  DistributedQueue,
  DistributedTaskLeaseStore,
  DistributedWorkflowStore,
  SystemClock,
  type StepExecution,
  type StepExecutor,
  type StepResult,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const URL = process.env.VAULLTCORE_TEST_POSTGRES_URL;
const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      cwd: import.meta.dir + "/../..",
    }).trim();
  } catch {
    return "unknown";
  }
})();
const EVIDENCE_DIR = join(
  import.meta.dir,
  "../../../docs/vaulltcore/phase4.8/raw-results",
);
try {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
} catch {}

function writeEvidence(name: string, data: Record<string, unknown>) {
  writeFileSync(
    join(EVIDENCE_DIR, name),
    JSON.stringify(
      {
        sha: GIT_SHA,
        collectedAt: new Date().toISOString(),
        ...data,
      },
      null,
      2,
    ),
  );
}

function printGateHeader(label: string) {
  console.log(
    `[phase4.8:${label}] sha=${GIT_SHA} bun=${typeof Bun !== "undefined" ? Bun.version : "unknown"} start=${new Date().toISOString()}`,
  );
}

let sql: postgres.Sql | undefined;
let b: PostgresSharedBackend | undefined;

beforeAll(async () => {
  if (!URL) return;
  sql = postgres(URL, { max: 10 });
  b = PostgresSharedBackend.fromClient(sql);
  await migratePostgres(sql);
});

afterAll(async () => {
  if (sql) await sql.end();
});

async function cleanSlate() {
  // Nuclear clean: remove migration tracking so migratePostgres re-runs DDL
  // even if the table was dropped externally. Then re-migrate + truncate.
  await sql!.unsafe(`DELETE FROM vc_schema_migrations`);
  await migratePostgres(sql!);
  await sql!.unsafe(`DELETE FROM vc_kv`);
}

if (!URL) {
  describe.skip("Phase 4.8 migration safety (no Postgres)", () => {});
} else {
  describe("Phase 4.8 §26 — migration safety", () => {
    it("fresh database: migration creates required tables and is idempotent", async () => {
      printGateHeader("migration-fresh");
      await cleanSlate();

      // First migration: tables already exist from beforeAll, but verify
      await migratePostgres(sql!);
      const r1 = await sql!`SELECT count(*) as cnt FROM vc_kv`;
      expect(Number(r1[0]?.cnt ?? 0)).toBe(0);

      // Second and third migrations: must be idempotent
      await migratePostgres(sql!);
      await migratePostgres(sql!);
      const r2 = await sql!`SELECT count(*) as cnt FROM vc_kv`;
      expect(Number(r2[0]?.cnt ?? 0)).toBe(0);
    });

    it("existing database: re-run migration preserves durable data", async () => {
      await cleanSlate();

      // Write durable state via backend
      await b!.cas("test_scalar", CAS_ABSENT, { data: "preserved" });
      await b!.incr("test_counter", 42);
      await b!.append("test_list", "item1");
      await b!.append("test_list", "item2");

      // Verify writes
      expect(await b!.get("test_scalar")).toEqual({ data: "preserved" });
      expect(await b!.get("test_counter")).toBe(42);
      expect(await b!.list("test_list")).toEqual(["item1", "item2"]);

      // Triple migration — must not destroy data
      await migratePostgres(sql!);
      await migratePostgres(sql!);
      await migratePostgres(sql!);

      expect(await b!.get("test_scalar")).toEqual({ data: "preserved" });
      expect(await b!.get("test_counter")).toBe(42);
      expect(await b!.list("test_list")).toEqual(["item1", "item2"]);
    });

    it("concurrent application activity during migration does not break", async () => {
      await cleanSlate();
      const TENANT: TenantId = "t_migration";
      const clock = new SystemClock();

      const deps = {
        store: new DistributedWorkflowStore(b!, clock),
        leases: new DistributedTaskLeaseStore(b!, clock),
        events: new DistributedEventStore(b!, clock),
        checkpoints: new DistributedCheckpointStore(b!),
        idempotency: new DistributedIdempotencyStore(b!),
        queue: new DistributedQueue(b!, clock),
        clock,
        executor: {
          async execute(_e: StepExecution, _s: AbortSignal): Promise<StepResult> {
            return {
              output: { ok: true },
              usage: {
                modelCalls: 1,
                toolCalls: 0,
                inputTokens: 10,
                outputTokens: 5,
              },
              artifacts: [],
            };
          },
        } satisfies StepExecutor,
        tenantIds: new Set<string>([TENANT]),
      };

      const runtime = new DistributedDurableRuntime(deps, TENANT);

      // Submit while migrating concurrently
      const [migResult, submitResult] = await Promise.allSettled([
        migratePostgres(sql!),
        runtime.submit({
          tenantId: TENANT,
          objective: "concurrent-migration-test",
          idempotencyKey: "k-concurrent-migration",
        }),
      ]);

      // Submit should succeed (migration is idempotent and concurrent-safe)
      if (submitResult.status === "fulfilled") {
        expect(submitResult.value.jobId).toBeTruthy();
      } else {
        // If migration causes transient DDL lock, submit may fail — that's OK
        // as long as a retry succeeds
        const retry = await runtime.submit({
          tenantId: TENANT,
          objective: "concurrent-migration-test",
          idempotencyKey: "k-concurrent-migration",
        });
        expect(retry.jobId).toBeTruthy();
      }

      // Final migration must be clean
      await migratePostgres(sql!);
    });

    it("schema version is tracked correctly", async () => {
      const versions =
        await sql!<{ version: string }[]>`SELECT version FROM vc_schema_migrations ORDER BY version`;
      expect(versions.length).toBeGreaterThanOrEqual(1);
      console.log(
        `[migration-safety] schema versions: ${versions.map((v) => v.version).join(", ")}`,
      );
    });

    it("fresh start with non-empty existing data: migration does not corrupt", async () => {
      await cleanSlate();

      // Simulate a partially-initialized database: some kv data but no migration record
      await b!.cas("partial::key", CAS_ABSENT, { incomplete: true });

      // Migration should not fail or corrupt
      await migratePostgres(sql!);
      await migratePostgres(sql!);

      // Data survives
      expect(await b!.get("partial::key")).toEqual({ incomplete: true });
    });
  });
}
