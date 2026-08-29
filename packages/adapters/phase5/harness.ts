/**
 * Phase 5 — Production Qualification & Adversarial Hardening Harness.
 *
 * Every experiment in Phase 5 flows through this module. Claims require
 * retained evidence: claim → experiment → raw JSON → acceptance criterion → result.
 *
 * Evidence directory: docs/vaulltcore/phase5/raw-results/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const POSTGRES_URL =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL ?? "";

/**
 * Resolve the repository root so evidence always lands in the repo-level
 * docs/ tree regardless of the working directory the tests are run from.
 */
function repoRoot(): string {
  try {
    return (
      execSync("git rev-parse --show-toplevel", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || process.cwd()
    );
  } catch {
    return process.cwd();
  }
}

export const EVIDENCE_DIR = path.join(
  repoRoot(),
  process.env.VAULLTCORE_EVIDENCE_DIR ?? "docs/vaulltcore/phase5/raw-results",
);

let evidenceDirEnsured = false;
function ensureEvidenceDir(): void {
  if (!evidenceDirEnsured) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    evidenceDirEnsured = true;
  }
}

export function writeEvidence(fileName: string, data: Record<string, unknown>): string {
  ensureEvidenceDir();
  const p = path.join(EVIDENCE_DIR, fileName);
  writeFileSync(
    p,
    JSON.stringify(
      {
        sha: execCapture("git rev-parse HEAD"),
        collectedAt: new Date().toISOString(),
        ...data,
      },
      null,
      2,
    ),
  );
  return p;
}

export function now(): number {
  return performance.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------------------------------------------------------------------------
// Environment fingerprint (Phase 5 §1 — architecture freeze)
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

export async function capturePgConfig(
  sql: import("postgres").Sql,
): Promise<Record<string, string>> {
  const rows: { name: string; setting: string; unit: string | null }[] = [];
  for (const key of PG_CONFIG_KEYS) {
    const result = await sql`
      SELECT name, setting, unit FROM pg_settings WHERE name = ${key}
    ` as { name: string; setting: string; unit: string | null }[];
    if (result.length > 0) rows.push(result[0]!);
  }
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.name] = r.unit ? `${r.setting}${r.unit}` : r.setting;
  }
  return out;
}

export function printGateHeader(suiteName: string): void {
  const fp = hostFingerprint();
  console.log(
    `[phase5:${suiteName}] sha=${fp.gitSha.slice(0, 12)} bun=${fp.bunVersion} start=${new Date().toISOString()} evidence=${EVIDENCE_DIR}`,
  );
}

// ---------------------------------------------------------------------------
// Nearest-rank percentiles from raw observations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB utilization sampling
// ---------------------------------------------------------------------------

export interface DbUtilization {
  active: number;
  idle: number;
  idleInTx: number;
  total: number;
  walBytesTotal: number | null;
}

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
    walBytesTotal = null;
  }
  return { active, idle, idleInTx, total: active + idle + idleInTx, walBytesTotal };
}

// ---------------------------------------------------------------------------
// Process management helpers for real SIGKILL experiments
// ---------------------------------------------------------------------------

export interface ChildProcessResult {
  pid: number;
  exitCode: number | null;
  signal: string | null;
  traceLines: string[];
}

export function parseTraceLines(raw: string): string[] {
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.trim());
}
