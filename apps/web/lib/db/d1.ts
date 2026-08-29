import Cloudflare from "cloudflare";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Add it in Settings → Environment.`);
  }
  return value;
}

export function getD1Config(): D1Config {
  return {
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requireEnv("D1_DATABASE_ID"),
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
  };
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let clientInstance: Cloudflare | null = null;

export function getD1Client(): Cloudflare {
  if (clientInstance) return clientInstance;

  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is not set. Add it in Settings → Environment.",
    );
  }

  clientInstance = new Cloudflare({ apiToken });
  return clientInstance;
}

/**
 * Reset the cached client instance — only for testing.
 * @internal
 */
export function _resetD1ClientForTesting(): void {
  clientInstance = null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export type D1QueryResult<T = Record<string, unknown>> = {
  results: T[];
  meta: {
    changed_db: boolean;
    changes: number;
    duration: number;
    last_row_id: number;
    rows_read: number;
    rows_written: number;
  };
};

/**
 * Execute a parameterised SQL query and return typed results.
 */
export async function d1Query<T = Record<string, unknown>>(
  sql: string,
  params?: string[],
): Promise<D1QueryResult<T>> {
  const config = getD1Config();
  const client = getD1Client();

  const response = await client.d1.database.query(config.databaseId, {
    account_id: config.accountId,
    sql,
    params,
  });

  // The SDK returns a paginated result; collect all pages
  const results: T[] = [];
  let meta: D1QueryResult<T>["meta"] = {
    changed_db: false,
    changes: 0,
    duration: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
  };

  for await (const result of response) {
    if (result.results) {
      results.push(...(result.results as T[]));
    }
    if (result.meta) {
      meta = {
        changed_db: result.meta.changed_db ?? false,
        changes: result.meta.changes ?? 0,
        duration: result.meta.duration ?? 0,
        last_row_id: result.meta.last_row_id ?? 0,
        rows_read: result.meta.rows_read ?? 0,
        rows_written: result.meta.rows_written ?? 0,
      };
    }
  }

  return { results, meta };
}

/**
 * Execute a parameterised SQL query and return raw array-of-arrays results.
 */
export async function d1Raw(
  sql: string,
  params?: string[],
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const config = getD1Config();
  const client = getD1Client();

  const response = await client.d1.database.raw(config.databaseId, {
    account_id: config.accountId,
    sql,
    params,
  });

  let columns: string[] = [];
  const rows: unknown[][] = [];

  for await (const result of response) {
    if (result.results?.columns) {
      columns = result.results.columns;
    }
    if (result.results?.rows) {
      rows.push(...result.results.rows);
    }
  }

  return { columns, rows };
}

/**
 * Execute multiple SQL statements as a batch (transaction).
 */
export async function d1Batch(
  statements: Array<{ sql: string; params?: string[] }>,
): Promise<D1QueryResult[]> {
  const config = getD1Config();
  const client = getD1Client();

  const response = await client.d1.database.query(config.databaseId, {
    account_id: config.accountId,
    batch: statements.map((s) => ({
      sql: s.sql,
      params: s.params,
    })),
  });

  const results: D1QueryResult[] = [];

  for await (const result of response) {
    results.push({
      results: (result.results ?? []) as Record<string, unknown>[],
      meta: {
        changed_db: result.meta?.changed_db ?? false,
        changes: result.meta?.changes ?? 0,
        duration: result.meta?.duration ?? 0,
        last_row_id: result.meta?.last_row_id ?? 0,
        rows_read: result.meta?.rows_read ?? 0,
        rows_written: result.meta?.rows_written ?? 0,
      },
    });
  }

  return results;
}
