/**
 * Phase 4.8 — production-reality gate harness.
 *
 * Everything measured in Phase 4.8 flows through this module so that every
 * claim is backed by retained raw evidence:
 *
 *   claim → experiment → raw evidence → acceptance criterion → result
 *
 * Evidence files land in VAULLTCORE_EVIDENCE_DIR (default:
 * docs/vaulltcore/phase4.8/raw-results). Summaries never replace raw data.
 */

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const POSTGRES_URL =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL ?? "";

export const EVIDENCE_DIR =
  process.env.VAULLTCORE_EVIDENCE_DIR ?? "docs/vaulltcore/phase4.8/raw-results";

/** Nearest-rank percentiles computed from RAW observations. Never smoothed. */
export function percentiles(samples: number[]): {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  if (samples.length === 0) {
    return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1]!,
  };
}

export function now(): number {
  return performance.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let evidenceDirEnsured = false;
function ensureEvidenceDir(): void {
  if (!evidenceDirEnsured) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    evidenceDirEnsured = true;
  }
}

/** Persist one experiment's full result object as pretty JSON. */
export function writeEvidence(fileName: string, data: unknown): string {
  ensureEvidenceDir();
  const p = path.join(EVIDENCE_DIR, fileName);
  writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

/** Append one JSONL row (soak/ladder time-series rows, trace events). */
export function appendEvidenceJsonl(fileName: string, row: unknown): void {
  ensureEvidenceDir();
  appendFileSync(path.join(EVIDENCE_DIR, fileName), `${JSON.stringify(row)}\n`);
}

// ---------------------------------------------------------------------------
// Environment fingerprint (§3 / §21)
// ---------------------------------------------------------------------------

export interface EnvFingerprint {
  gitSha: string;
  bunVersion: string;
  nodeVersion: string;
  platform: string;
  hostCpus: number;
  hostMemTotalMb: number;
  cpuModel: string;
  postgresUrlSanitized: string;
  collectedAt: string;
}

let fingerprintCache: EnvFingerprint | undefined;

export function hostFingerprint(): EnvFingerprint {
  if (fingerprintCache) return fingerprintCache;
  let cpuModel = "unknown";
  try {
    const info = os.cpus()[0];
    if (info) cpuModel = info.model;
  } catch {
    // leave unknown
  }
  fingerprintCache = {
    gitSha: execCapture("git rev-parse HEAD"),
    bunVersion: Bun.version,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    hostCpus: os.cpus().length,
    hostMemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    cpuModel,
    postgresUrlSanitized: POSTGRES_URL.replace(/:\/\/[^@]*@/, "://***@"),
    collectedAt: new Date().toISOString(),
  };
  return fingerprintCache;
}

function execCapture(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const PG_CONFIG_KEYS = [
  "server_version",
  "fsync",
  "synchronous_commit",
  "wal_level",
  "full_page_writes",
  "max_connections",
  "shared_buffers",
  "work_mem",
  "max_wal_size",
  "checkpoint_timeout",
  "default_transaction_isolation",
  "statement_timeout",
] as const;

type PgConfigRow = { name: string; setting: string; unit: string | null };

/** Capture the live PostgreSQL configuration (durability posture included). */
export async function capturePgConfig(
  sql: import("postgres").Sql,
): Promise<Record<string, string>> {
  const rows = (await sql`
    SELECT name, setting, unit FROM pg_settings
    WHERE name = ANY(${sql.array([...PG_CONFIG_KEYS])})
  `) as PgConfigRow[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.name] = r.unit ? `${r.setting}${r.unit}` : r.setting;
  }
  return out;
}

export function printGateHeader(suiteName: string): void {
  const fp = hostFingerprint();
  console.log(
    `[phase4.8:${suiteName}] sha=${fp.gitSha.slice(0, 12)} bun=${fp.bunVersion} start=${new Date().toISOString()} evidence=${EVIDENCE_DIR}`,
  );
}

// ---------------------------------------------------------------------------
// Database utilization samplers (pool/connections/WAL/CPU)
// ---------------------------------------------------------------------------

export interface DbUtilization {
  active: number;
  idle: number;
  idleInTx: number;
  total: number;
  walBytesTotal: number | null;
}

/** Connection states + WAL volume for this database, from pg_stat views. */
export async function sampleDbUtilization(
  sql: import("postgres").Sql,
): Promise<DbUtilization> {
  const act = (await sql`
    SELECT state, COUNT(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  `) as { state: string | null; n: number }[];
  let active = 0;
  let idle = 0;
  let idleInTx = 0;
  for (const r of act) {
    if (r.state === "active") active += r.n;
    else if (r.state === "idle") idle += r.n;
    else if (
      r.state === "idle in transaction" ||
      r.state === "idle in transaction (aborted)"
    ) {
      idleInTx += r.n;
    }
  }
  let walBytesTotal: number | null = null;
  try {
    const wal = (await sql`SELECT wal_bytes FROM pg_stat_wal`) as {
      wal_bytes: string;
    }[];
    walBytesTotal = Number(wal[0]?.wal_bytes ?? 0);
  } catch {
    walBytesTotal = null; // view unavailable — reported as null, never invented
  }
  return {
    active,
    idle,
    idleInTx,
    total: active + idle + idleInTx,
    walBytesTotal,
  };
}

/** Cumulative CPU seconds of all postgres processes (caller diffs samples). */
export function postgresCpuSeconds(): number {
  try {
    const out = execSync(
      "ps -eo comm,time | awk '$1 ~ /postgres/ {split($2,t,\":\"); s+=t[length(t)]+60*t[length(t)-1]+3600*(length(t)==3?t[1]:0)} END {print s+0}'",
      { encoding: "utf8", shell: "/bin/bash" },
    ).trim();
    return Number(out) || 0;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Fault-injecting SharedBackend wrapper (statement-boundary crash windows §9)
// ---------------------------------------------------------------------------

import type { SharedBackend } from "@vaulltcore/workflow";

export type BackendMethod =
  | "cas"
  | "get"
  | "append"
  | "list"
  | "incr"
  | "del"
  | "keys";

export class InjectedFailure extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "InjectedFailure";
    this.kind = kind;
  }
}

/**
 * Wraps a SharedBackend, records the exact call sequence (the T-boundary
 * map), and injects failures at chosen boundaries:
 *
 *  - armCrashBeforeCall(n, method?) → hard death before the n-th call
 *  - armTransientFailures(k, method?) → connection-reset style failures
 */
export class FaultBackend implements SharedBackend {
  readonly callLog: { method: BackendMethod; key: string; index: number }[] =
    [];
  private crashBefore: {
    index: number;
    method: BackendMethod | null;
    armedAtLogLength: number;
  } | null = null;
  private transientLeft = 0;
  private transientMethod: BackendMethod | null = null;

  constructor(private readonly inner: SharedBackend) {}

  /** Die (throw) immediately BEFORE the n-th (1-based, relative-to-arm) call. */
  armCrashBeforeCall(index: number, method: BackendMethod | null = null): void {
    this.crashBefore = { index, method, armedAtLogLength: this.callLog.length };
  }

  /** Fail the next k calls matching method (or any) with a transient error. */
  armTransientFailures(
    count: number,
    method: BackendMethod | null = null,
  ): void {
    this.transientLeft = count;
    this.transientMethod = method;
  }

  resetFaults(): void {
    this.crashBefore = null;
    this.transientLeft = 0;
  }

  private shouldCrash(method: BackendMethod): boolean {
    if (!this.crashBefore) return false;
    const nextIndex =
      this.callLog.length - this.crashBefore.armedAtLogLength + 1;
    if (nextIndex !== this.crashBefore.index) return false;
    if (this.crashBefore.method && this.crashBefore.method !== method) {
      return false;
    }
    this.crashBefore = null;
    return true;
  }

  private maybeFail(method: BackendMethod): void {
    if (
      this.transientLeft > 0 &&
      (!this.transientMethod || this.transientMethod === method)
    ) {
      this.transientLeft--;
      throw new InjectedFailure(
        "connection_reset",
        "injected connection reset (Phase 4.8 fault injection)",
      );
    }
  }

  private async run<T>(
    method: BackendMethod,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.shouldCrash(method)) {
      throw new InjectedFailure(
        "crash_boundary",
        `worker died before ${method}(${key})`,
      );
    }
    this.callLog.push({ method, key, index: this.callLog.length + 1 });
    this.maybeFail(method);
    return fn();
  }

  cas(key: string, expected: unknown, value: unknown): Promise<boolean> {
    return this.run("cas", key, () => this.inner.cas(key, expected, value));
  }
  get(key: string): Promise<unknown> {
    return this.run("get", key, () => this.inner.get(key));
  }
  append(key: string, value: unknown): Promise<void> {
    return this.run("append", key, () => this.inner.append(key, value));
  }
  list(key: string): Promise<unknown[]> {
    return this.run("list", key, () => this.inner.list(key));
  }
  incr(key: string, by = 1): Promise<number> {
    return this.run("incr", key, () => this.inner.incr(key, by));
  }
  del(key: string): Promise<void> {
    return this.run("del", key, () => this.inner.del(key));
  }
  keys(prefix: string): Promise<string[]> {
    return this.run("keys", prefix, () => this.inner.keys(prefix));
  }
}

// ---------------------------------------------------------------------------
// Network delay proxy — real TCP path with injected RTT (§4)
// ---------------------------------------------------------------------------

export interface DelayProxyOptions {
  upstreamHost: string;
  upstreamPort: number;
  /** Full round-trip latency to inject, milliseconds. */
  rttMs: number;
  /** ± jitter applied to each one-way delay. */
  jitterMs?: number;
}

export interface DelayProxyStats {
  connections: number;
  bytesUp: number;
  bytesDown: number;
}

export interface DelayProxyHandle {
  port: number;
  stats: DelayProxyStats;
  close(): Promise<void>;
}

interface ConnState {
  upstream: Awaited<ReturnType<typeof Bun.connect>> | null;
  upChain: Promise<void>;
  downChain: Promise<void>;
  /** Chunks that arrived before the upstream connection resolved. */
  pendingUp: Uint8Array[];
}

/**
 * TCP proxy adding ~rttMs/2 delay per direction over REAL kernel sockets, so
 * benchmark traffic traverses actual TCP through the kernel network stack.
 * Chunk order per direction is preserved via promise chaining.
 */
export async function startDelayProxy(
  opts: DelayProxyOptions,
): Promise<DelayProxyHandle> {
  const stats: DelayProxyStats = { connections: 0, bytesUp: 0, bytesDown: 0 };
  const half = Math.max(0, opts.rttMs / 2);
  const jitter = opts.jitterMs ?? Math.min(2, half * 0.25);

  const stateMap = new WeakMap<object, ConnState>();

  const oneWayDelay = (): number =>
    Math.max(0, half + (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0));

  const enqueueDelayed = (
    chain: Promise<void>,
    write: () => void,
  ): Promise<void> => {
    const next = chain.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            write();
            resolve();
          }, oneWayDelay());
        }),
    );
    next.catch(() => undefined);
    return next;
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client): void {
        stats.connections++;
        const st: ConnState = {
          upstream: null,
          upChain: Promise.resolve(),
          downChain: Promise.resolve(),
          pendingUp: [],
        };
        stateMap.set(client, st);
        Bun.connect({
          hostname: opts.upstreamHost,
          port: opts.upstreamPort,
          socket: {
            data(_up, chunk): void {
              st.downChain = enqueueDelayed(st.downChain, () => {
                try {
                  client.write(chunk);
                } catch {
                  /* client gone */
                }
              });
            },
            close(): void {
              try {
                client.end();
              } catch {
                /* already closed */
              }
            },
            error(): void {
              try {
                client.end();
              } catch {
                /* already closed */
              }
            },
          },
        })
          .then((up) => {
            st.upstream = up;
            // Flush anything the client sent during dial (PG startup packet).
            for (const c of st.pendingUp.splice(0)) {
              try {
                up.write(c);
              } catch {
                /* upstream gone */
              }
            }
          })
          .catch(() => {
            /* upstream refused — leave client to time out */
          });
      },
      data(client, chunk): void {
        const st = stateMap.get(client);
        if (!st) return;
        if (!st.upstream) {
          st.pendingUp.push(chunk);
          return;
        }
        stats.bytesUp += chunk.byteLength;
        st.upChain = enqueueDelayed(st.upChain, () => {
          try {
            st.upstream?.write(chunk);
          } catch {
            /* upstream gone */
          }
        });
      },
      close(client): void {
        const st = stateMap.get(client);
        try {
          st?.upstream?.end();
        } catch {
          /* noop */
        }
        stateMap.delete(client);
      },
      error(client): void {
        try {
          client.end();
        } catch {
          /* noop */
        }
        const st = stateMap.get(client);
        try {
          st?.upstream?.end();
        } catch {
          /* noop */
        }
      },
    },
  });

  return {
    port: server.port,
    stats,
    async close(): Promise<void> {
      server.stop(true);
      await sleep(Math.max(20, half * 2 + 10));
    },
  };
}
