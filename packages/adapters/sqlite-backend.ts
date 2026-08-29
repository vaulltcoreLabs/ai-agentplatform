/**
 * Phase 4.5 — production `SharedBackend` adapter over SQLite.
 *
 * LAYER 2 (ADAPTER). This is the first real durable backend for the
 * provider-neutral distributed stores in `@vaulltcore/workflow`. Core packages
 * do NOT import this module; the dependency points the other way
 * (adapters → workflow contracts).
 *
 * Why SQLite:
 *  - The control-plane plan (docs/vaulltcore/infrastructure/README.md,
 *    phase4.1/cloudflare-mapping.md) targets Cloudflare D1, which is SQLite.
 *    The schema and SQL semantics here port to D1 directly.
 *  - `BEGIN IMMEDIATE` transactions + WAL mode give exactly the atomicity the
 *    `SharedBackend` contract requires: every mutator (`cas`, `append`, `incr`,
 *    `del`) executes inside ONE transaction, serialized by the database engine
 *    itself across independent connections. No read-modify-write across
 *    separate network round-trips anywhere.
 *
 * Two `SqliteSharedBackend` instances opened on the same file behave like two
 * processes sharing one production database: concurrent writers block on the
 * write lock (busy_timeout) and every mutation is atomic. This makes the
 * distributed acceptance tests meaningful — they are NOT two objects over one
 * in-process Map.
 */

import { Database } from "bun:sqlite";
import { CAS_ABSENT, type SharedBackend } from "@vaulltcore/workflow";

/** bun:sqlite returns `null` (not undefined) when a query matches no rows. */
type MaybeRow = KvRow | null;

function isRow(row: MaybeRow): row is KvRow {
  return row != null;
}

interface KvRow {
  key: string;
  kind: "scalar" | "list" | "counter";
  value: string | null;
  counter: number | null;
}

/** Structural equality on JSON-round-tripped values (CAS comparison). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
  );
}

/**
 * `db.transaction(fn, "immediate")` — acquire the write lock up front.
 * bun-types lacks the two-argument overload, hence the narrow cast.
 */
function immediate<A extends unknown[], R>(
  db: Database,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (
    db.transaction as unknown as (
      f: (...args: A) => R,
      mode: string,
    ) => (...args: A) => R
  )(fn, "immediate");
}

export class SqliteSharedBackend implements SharedBackend {
  private readonly db: Database;
  private readonly ownsConnection: boolean;

  private readonly stmtGet: ReturnType<Database["query"]>;
  private readonly stmtInsertScalar: ReturnType<Database["query"]>;
  private readonly stmtUpdateValue: ReturnType<Database["query"]>;
  private readonly stmtDelete: ReturnType<Database["query"]>;
  private readonly stmtAllKeys: ReturnType<Database["query"]>;
  private readonly stmtInsertCounter: ReturnType<Database["query"]>;
  private readonly stmtUpdateCounter: ReturnType<Database["query"]>;
  private readonly stmtInsertList: ReturnType<Database["query"]>;

  private readonly txCas: (
    key: string,
    absent: number,
    expectedJson: string | null,
    valueJson: string,
  ) => boolean;
  private readonly txAppend: (key: string, valueJson: string) => void;
  private readonly txAppendUnique: (
    key: string,
    dedupKey: string,
    valueJson: string,
  ) => { appended: boolean; existingJson: string | null };
  private readonly txIncr: (key: string, by: number) => number;
  private readonly txDel: (key: string) => void;

  constructor(target: string | Database) {
    this.ownsConnection = typeof target === "string";
    this.db = typeof target === "string" ? new Database(target) : target;

    // WAL lets readers proceed during writes; busy_timeout makes competing
    // writers wait for the lock instead of failing — this is what turns N
    // connections into one linearizable history.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vc_kv (
        key     TEXT PRIMARY KEY,
        kind    TEXT NOT NULL,
        value   TEXT,
        counter INTEGER
      )
    `);

    const q = this.db.query.bind(this.db);
    this.stmtGet = q(
      "SELECT key, kind, value, counter FROM vc_kv WHERE key = ?",
    );
    this.stmtInsertScalar = q(
      "INSERT INTO vc_kv (key, kind, value, counter) VALUES (?, 'scalar', ?, NULL)",
    );
    this.stmtUpdateValue = q("UPDATE vc_kv SET value = ? WHERE key = ?");
    this.stmtDelete = q("DELETE FROM vc_kv WHERE key = ?");
    this.stmtAllKeys = q("SELECT key FROM vc_kv");
    this.stmtInsertCounter = q(
      "INSERT INTO vc_kv (key, kind, value, counter) VALUES (?, 'counter', NULL, ?)",
    );
    this.stmtUpdateCounter = q("UPDATE vc_kv SET counter = ? WHERE key = ?");
    this.stmtInsertList = q(
      "INSERT INTO vc_kv (key, kind, value, counter) VALUES (?, 'list', ?, NULL)",
    );

    // IMMEDIATE transactions acquire the write lock up front so concurrent
    // mutators queue behind one lock instead of failing mid-upgrade. Each
    // mutator below is a SINGLE transaction — the atomicity requirement.
    this.txCas = immediate(
      this.db,
      (
        key: string,
        absent: number,
        expectedJson: string | null,
        valueJson: string,
      ): boolean => {
        const row = this.stmtGet.get(key) as MaybeRow;
        if (absent === 1) {
          if (isRow(row)) return false;
          this.stmtInsertScalar.run(key, valueJson);
          return true;
        }
        if (
          !isRow(row) ||
          row.kind !== "scalar" ||
          row.value === null ||
          expectedJson === null
        ) {
          return false;
        }
        let current: unknown;
        let expected: unknown;
        try {
          current = JSON.parse(row.value);
          expected = JSON.parse(expectedJson);
        } catch {
          return false;
        }
        if (!deepEqual(current, expected)) return false;
        this.stmtUpdateValue.run(valueJson, key);
        return true;
      },
    );

    this.txAppend = immediate(
      this.db,
      (key: string, valueJson: string): void => {
        const row = this.stmtGet.get(key) as MaybeRow;
        const next: unknown[] =
          !isRow(row) || row.value === null
            ? []
            : (JSON.parse(row.value) as unknown[]);
        next.push(JSON.parse(valueJson));
        if (!isRow(row)) {
          this.stmtInsertList.run(key, JSON.stringify(next));
        } else {
          this.stmtUpdateValue.run(JSON.stringify(next), key);
        }
      },
    );

    // Phase 4.8 (D3): exactly-once append — marker claim + stream push in one
    // IMMEDIATE transaction. BEGIN IMMEDIATE serializes writers, so a
    // concurrent caller either sees the committed marker or creates it.
    this.txAppendUnique = immediate(
      this.db,
      (
        key: string,
        dedupKey: string,
        valueJson: string,
      ): { appended: boolean; existingJson: string | null } => {
        const marker = this.stmtGet.get(dedupKey) as MaybeRow;
        if (isRow(marker)) {
          return { appended: false, existingJson: marker.value ?? null };
        }
        this.stmtInsertScalar.run(dedupKey, valueJson);
        const row = this.stmtGet.get(key) as MaybeRow;
        const next: unknown[] =
          !isRow(row) || row.value === null
            ? []
            : (JSON.parse(row.value) as unknown[]);
        next.push(JSON.parse(valueJson));
        if (!isRow(row)) {
          this.stmtInsertList.run(key, JSON.stringify(next));
        } else {
          this.stmtUpdateValue.run(JSON.stringify(next), key);
        }
        return { appended: true, existingJson: null };
      },
    );

    this.txIncr = immediate(this.db, (key: string, by: number): number => {
      const row = this.stmtGet.get(key) as MaybeRow;
      if (!isRow(row)) {
        this.stmtInsertCounter.run(key, by);
        return by;
      }
      if (row.kind !== "counter" || row.counter === null) {
        throw new Error(`incr on non-counter key '${key}'`);
      }
      const next = row.counter + by;
      this.stmtUpdateCounter.run(next, key);
      return next;
    });

    this.txDel = immediate(this.db, (key: string): void => {
      this.stmtDelete.run(key);
    });
  }

  async cas(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const absent = expected === CAS_ABSENT;
    return this.txCas(
      key,
      absent ? 1 : 0,
      absent ? null : JSON.stringify(expected ?? null),
      JSON.stringify(value ?? null),
    );
  }

  async get(key: string): Promise<unknown> {
    const row = this.stmtGet.get(key) as MaybeRow;
    if (!isRow(row)) return undefined;
    if (row.kind === "counter") return row.counter;
    return row.value === null ? undefined : JSON.parse(row.value);
  }

  async append(key: string, value: unknown): Promise<void> {
    this.txAppend(key, JSON.stringify(value ?? null));
  }

  /** Phase 4.8 (D3): see SharedBackend.appendUnique. */
  async appendUnique(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }> {
    const res = this.txAppendUnique(
      key,
      dedupKey,
      JSON.stringify(value ?? null),
    );
    return res.appended
      ? { appended: true }
      : {
          appended: false,
          existing:
            res.existingJson === null
              ? undefined
              : JSON.parse(res.existingJson),
        };
  }

  async list(key: string): Promise<unknown[]> {
    const row = this.stmtGet.get(key) as MaybeRow;
    if (!isRow(row) || row.value === null) return [];
    return JSON.parse(row.value) as unknown[];
  }

  async incr(key: string, by = 1): Promise<number> {
    return this.txIncr(key, by);
  }

  async del(key: string): Promise<void> {
    this.txDel(key);
  }

  async keys(prefix: string): Promise<string[]> {
    const rows = this.stmtAllKeys.all() as Array<{ key: string }>;
    return rows.map((r) => r.key).filter((k) => k.startsWith(prefix));
  }

  /** Close the connection if this instance opened it. */
  close(): void {
    if (this.ownsConnection) this.db.close();
  }
}
