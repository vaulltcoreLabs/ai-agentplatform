/**
 * Phase 4.6 — production `SharedBackend` adapter over Postgres.
 *
 * LAYER 2 (ADAPTER). Depends on the workflow contracts, never the reverse.
 * Uses the `postgres` client already present in the repository (pooled,
 * parameterized queries only — no string-concatenated SQL).
 *
 * ATOMICITY: every mutator is a SINGLE SQL statement, atomic under Postgres
 * row-level locking:
 *  - cas(absent)   → INSERT … ON CONFLICT DO NOTHING
 *  - cas(matched)  → UPDATE … WHERE value IS NOT DISTINCT FROM $expected
 *                    (jsonb equality = structural deep equality)
 *  - append        → INSERT … ON CONFLICT DO UPDATE SET value = value || $chunk
 *  - incr          → INSERT … ON CONFLICT DO UPDATE SET counter =
 *                    counter + EXCLUDED.counter RETURNING counter
 *  - del           → DELETE
 *
 * No SELECT→compute→UPDATE sequences exist anywhere; correctness never
 * depends on application-level serialization.
 *
 * TRANSACTIONS: none of the mutators hold a transaction across anything but a
 * single statement. The adapter NEVER holds a transaction while workflow/
 * agent/sandbox work executes — the database coordinates durable state only
 * (see docs/vaulltcore/phase4.6/database-model.md, §transaction boundaries).
 */

import postgres, { type JSONValue } from "postgres";
import { CAS_ABSENT, type SharedBackend } from "@vaulltcore/workflow";
interface KvRow {
  kind: "scalar" | "list" | "counter";
  value: unknown;
  counter: string | number | null;
}

// SharedBackend values are contractually JSON-serializable state; the driver
// only needs its own view of that fact.
const asJson = (v: unknown): JSONValue => v as JSONValue;

/** Versioned migrations applied by `migratePostgres()` — forward-only. */
export const MIGRATIONS: readonly { version: string; sql: string }[] = [
  {
    version: "001_shared_backend",
    sql: `
      CREATE TABLE IF NOT EXISTS vc_kv (
        key     TEXT PRIMARY KEY,
        kind    TEXT NOT NULL CHECK (kind IN ('scalar', 'list', 'counter')),
        value   JSONB,
        counter BIGINT,
        CONSTRAINT kind_payload CHECK (
          (kind = 'counter'  AND counter IS NOT NULL AND value IS NULL) OR
          (kind <> 'counter' AND counter IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS vc_kv_key_prefix_idx ON vc_kv (key text_pattern_ops);
      CREATE TABLE IF NOT EXISTS vc_schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
];

/** Apply pending migrations idempotently. Never destructive at runtime. */
export async function migratePostgres(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vc_schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await sql`SELECT version FROM vc_schema_migrations`).map((r) =>
      String((r as { version: string }).version),
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await sql.begin(async (tx: postgres.TransactionSql) => {
      await tx.unsafe(migration.sql);
      // The migration SQL also creates the tracking table on first run; use
      // raw insert that tolerates re-creation ordering.
      await tx`INSERT INTO vc_schema_migrations (version) VALUES (${migration.version}) ON CONFLICT DO NOTHING`;
    });
  }
}

function escapeLike(prefix: string): string {
  return prefix.replace(/([%_\\])/g, "\\$1");
}

export class PostgresSharedBackend implements SharedBackend {
  private readonly ownsClient: boolean;

  private constructor(private target: postgres.Sql | string) {
    this.ownsClient = typeof target === "string";
  }

  /** Open against an existing client (pool supplied by the caller). */
  static fromClient(sql: postgres.Sql): PostgresSharedBackend {
    return new PostgresSharedBackend(sql);
  }

  /** Open from a URL with a small pool; applies migrations idempotently. */
  static async open(url: string): Promise<PostgresSharedBackend> {
    const backend = new PostgresSharedBackend(url);
    const db = postgres(url, { max: 10 });
    backend.target = db;
    await migratePostgres(db);
    return backend;
  }

  private async client(): Promise<postgres.Sql> {
    if (typeof this.target === "string") {
      throw new Error(
        "PostgresSharedBackend not connected; use .open() or .fromClient()",
      );
    }
    return this.target;
  }

  async cas(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const db = await this.client();
    if (expected === CAS_ABSENT) {
      const created = await db`
        INSERT INTO vc_kv (key, kind, value)
        VALUES (${key}, 'scalar', ${db.json(asJson(value ?? null))})
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `;
      return created.length > 0;
    }
    // NOTE: parameters are passed via db.json() so both sides of the
    // comparison arrive as true jsonb values. Manual stringification with an
    // inline ::jsonb cast proved unreliable under this driver's type
    // inference (text params adjacent to operators compared unequal to
    // identical literals).
    const updated = await db`
      UPDATE vc_kv
      SET value = ${db.json(asJson(value ?? null))}
      WHERE key = ${key}
        AND value IS NOT DISTINCT FROM ${db.json(asJson(expected ?? null))}
      RETURNING key
    `;
    return updated.length > 0;
  }

  async get(key: string): Promise<unknown> {
    const db = await this.client();
    const rows =
      await db`SELECT kind, value, counter FROM vc_kv WHERE key = ${key}`;
    const row = rows[0] as KvRow | undefined;
    if (!row) return undefined;
    if (row.kind === "counter") return Number(row.counter);
    return row.value;
  }

  async append(key: string, entry: unknown): Promise<void> {
    const db = await this.client();
    const chunk = [entry ?? null];
    await db`
      INSERT INTO vc_kv (key, kind, value)
      VALUES (${key}, 'list', ${db.json(asJson(chunk))})
      ON CONFLICT (key) DO UPDATE
        SET value = vc_kv.value || EXCLUDED.value
    `;
  }

  /**
   * Phase 4.8 (D3): exactly-once list-append. Marker insert and stream append
   * commit in ONE transaction; a concurrent caller inserting the same dedup
   * key blocks on the primary-key conflict until the winner commits, then its
   * ON CONFLICT DO NOTHING yields the committed value. A crash at any point
   * rolls both statements back — no claimed-but-unwritten marker can exist.
   */
  async appendUnique(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }> {
    const db = await this.client();
    return db.begin(async (tx) => {
      const ins = await tx`
        INSERT INTO vc_kv (key, kind, value)
        VALUES (${dedupKey}, 'scalar', ${tx.json(asJson(value ?? null))})
        ON CONFLICT (key) DO NOTHING
        RETURNING value
      `;
      if (ins.length > 0) {
        await tx`
          INSERT INTO vc_kv (key, kind, value)
          VALUES (${key}, 'list', ${tx.json(asJson([value ?? null]))})
          ON CONFLICT (key) DO UPDATE
            SET value = vc_kv.value || EXCLUDED.value
        `;
        return { appended: true };
      }
      const rows = await tx`
        SELECT value FROM vc_kv WHERE key = ${dedupKey}
      `;
      const row = rows[0] as { value: unknown } | undefined;
      return { appended: false, existing: row?.value };
    });
  }

  async list(key: string): Promise<unknown[]> {
    const db = await this.client();
    const rows =
      await db`SELECT value FROM vc_kv WHERE key = ${key} AND kind = 'list'`;
    const row = rows[0] as { value: unknown } | undefined;
    return row && row.value !== null ? (row.value as unknown[]) : [];
  }

  async incr(key: string, by = 1): Promise<number> {
    const db = await this.client();
    const rows = await db`
      INSERT INTO vc_kv (key, kind, counter)
      VALUES (${key}, 'counter', ${by}::bigint)
      ON CONFLICT (key) DO UPDATE
        SET counter = COALESCE(vc_kv.counter, 0) + EXCLUDED.counter
      WHERE vc_kv.kind = 'counter'
      RETURNING counter
    `;
    if (rows.length === 0) {
      throw new Error(`incr on non-counter key '${key}'`);
    }
    return Number((rows[0] as { counter: string | number }).counter);
  }

  async del(key: string): Promise<void> {
    const db = await this.client();
    await db`DELETE FROM vc_kv WHERE key = ${key}`;
  }

  async keys(prefix: string): Promise<string[]> {
    const db = await this.client();
    const rows = await db`
      SELECT key FROM vc_kv
      WHERE key LIKE ${escapeLike(prefix) + "%"} ESCAPE '\\'
      ORDER BY key
    `;
    return rows.map((r) => String((r as { key: string }).key));
  }

  close(): void {
    if (this.ownsClient && typeof this.target !== "string") {
      this.target.end({ timeout: 1 });
    }
  }
}
