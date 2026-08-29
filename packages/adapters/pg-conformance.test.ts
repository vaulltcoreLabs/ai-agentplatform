/**
 * Phase 4.6 — Postgres adapter conformance.
 *
 * Gated on a live database: set VAULLTCORE_TEST_POSTGRES_URL (or reuse
 * POSTGRES_URL) to execute. Without it the suite is skipped — the adapter is
 * CONTRACTUAL until these tests pass against a real server.
 *
 *   VAULLTCORE_TEST_POSTGRES_URL=postgres://localhost:5432/vaulltcore_test \
 *     bun test packages/adapters/pg-conformance.test.ts
 */

import postgres from "postgres";
import { describe } from "bun:test";
import {
  describeSharedBackendConformance,
  type BackendFactory,
} from "./conformance";
import { migratePostgres, PostgresSharedBackend } from "./pg-backend";

const url =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

const pools: postgres.Sql[] = [];

function newClient(): postgres.Sql {
  const pool = postgres(url!, { max: 5 });
  pools.push(pool);
  return pool;
}

if (!url) {
  // CONTRACTUAL until executed against a live server.
  describe.skip("SharedBackend conformance — PostgresSharedBackend (no URL)", () => {});
} else {
  describeSharedBackendConformance({
    name: "PostgresSharedBackend (independent pooled connections)",
    // Isolation: the shared suite assumes EMPTY durable state per test
    // (BackendFactory contract), so every create purges rows left by earlier
    // tests/runs. Connections remain independent; only initial state resets.
    create: async () => {
      const client = newClient();
      await migratePostgres(client);
      await client`DELETE FROM vc_kv`;
      await client`DELETE FROM vc_schema_migrations WHERE version <> '001_shared_backend'`;
      return PostgresSharedBackend.fromClient(client);
    },
    createPair: async () => {
      const first = newClient();
      await migratePostgres(first);
      await first`DELETE FROM vc_kv`;
      return [
        PostgresSharedBackend.fromClient(first),
        PostgresSharedBackend.fromClient(newClient()),
      ];
    },
    dispose: () => {
      for (const pool of pools.splice(0)) pool.end({ timeout: 1 });
    },
  } satisfies BackendFactory);
}
