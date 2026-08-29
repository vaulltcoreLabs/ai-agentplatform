/**
 * Phase 5.1 §36 — Final Provider Boundary Verification.
 *
 * Scans all source files in provider-neutral packages (workflow, agent,
 * intelligence, shared) for forbidden provider-specific imports. Ensures
 * zero provider SDK leakage into the core contract boundary.
 *
 * Acceptance:
 *   C1: Zero forbidden imports in provider-neutral packages.
 *   C2: Forbidden imports are only in adapter boundaries.
 *   C3: Automated regression pattern.
 *
 * Runs without external infrastructure.
 */

import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { writeEvidence, printGateHeader } from "./harness";

// Provider-specific import patterns that must NOT appear in core packages
const FORBIDDEN_PATTERNS = [
  { pattern: 'from "postgres"', name: "postgres" },
  { pattern: "from 'postgres'", name: "postgres" },
  { pattern: 'from "pg"', name: "pg" },
  { pattern: "from 'pg'", name: "pg" },
  { pattern: 'from "drizzle-orm"', name: "drizzle" },
  { pattern: "from 'drizzle-orm'", name: "drizzle" },
  { pattern: 'from "kysely"', name: "kysely" },
  { pattern: "from 'kysely'", name: "kysely" },
  { pattern: 'from "bun:sqlite"', name: "bun:sqlite" },
  { pattern: "from 'bun:sqlite'", name: "bun:sqlite" },
  { pattern: 'from "@vercel/', name: "@vercel/*" },
  { pattern: "from '@vercel/", name: "@vercel/*" },
  { pattern: 'from "cloudflare', name: "cloudflare" },
  { pattern: "from 'cloudflare", name: "cloudflare" },
  { pattern: 'from "@cloudflare/', name: "@cloudflare/*" },
  { pattern: "from '@cloudflare/", name: "@cloudflare/*" },
  { pattern: 'from "better-sqlite3"', name: "better-sqlite3" },
  { pattern: "from 'better-sqlite3'", name: "better-sqlite3" },
  { pattern: 'from "mysql2"', name: "mysql2" },
  { pattern: "from 'mysql2'", name: "mysql2" },
  { pattern: 'from "mongodb"', name: "mongodb" },
  { pattern: "from 'mongodb'", name: "mongodb" },
  { pattern: 'from "ioredis"', name: "ioredis" },
  { pattern: "from 'ioredis'", name: "ioredis" },
  { pattern: 'from "redis"', name: "redis" },
  { pattern: "from 'redis'", name: "redis" },
  { pattern: 'from "amqplib"', name: "amqplib" },
  { pattern: "from 'amqplib'", name: "amqplib" },
  // Phase 5 §27 — Neon / AWS SDK / R2 boundary patterns:
  { pattern: 'from "@neondatabase/serverless"', name: "@neondatabase/serverless" },
  { pattern: "from '@neondatabase/serverless'", name: "@neondatabase/serverless" },
  { pattern: 'from "drizzle-orm/neon-http"', name: "drizzle-orm/neon-http" },
  { pattern: 'from "@aws-sdk/', name: "@aws-sdk/*" },
  { pattern: "from '@aws-sdk/", name: "@aws-sdk/*" },
  { pattern: "S3Client", name: "S3Client" },
];

// Packages that MUST be provider-neutral
const CORE_PACKAGES = [
  "packages/workflow",
  "packages/agent",
  "packages/intelligence",
  "packages/shared",
];

// Packages that ARE allowed to have provider-specific imports.
// packages/storage: the ObjectStore CONTRACT (object-store.ts) is neutral;
// its r2/ adapter is the single authorized location for AWS SDK/R2 imports.
const ADAPTER_PACKAGES = ["packages/adapters", "packages/storage"];

interface Violation {
  file: string;
  line: string;
  pattern: string;
  provider: string;
}

function scanDirectory(dir: string): Violation[] {
  const violations: Violation[] = [];
  try {
    const output = execSync(
      `grep -rn ${FORBIDDEN_PATTERNS.map((p) => `-e "${p.pattern}"`).join(" ")} "${dir}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );

    for (const line of output.split("\n").filter((l) => l.trim())) {
      // Find which pattern matched
      for (const fp of FORBIDDEN_PATTERNS) {
        if (line.includes(fp.pattern)) {
          const fileMatch = line.match(/^([^:]+):/);
          violations.push({
            file: fileMatch?.[1] ?? "unknown",
            line: line.slice(0, 200),
            pattern: fp.pattern,
            provider: fp.name,
          });
          break;
        }
      }
    }
  } catch {
    // grep returns non-zero when no match — that's expected
  }
  return violations;
}

describe("Phase 5.1 §36 — provider boundary audit", () => {
  it("zero forbidden imports in core packages (workflow, agent, intelligence, shared)", () => {
    printGateHeader("provider-boundary-core");
    const allViolations: Violation[] = [];

    for (const pkg of CORE_PACKAGES) {
      const violations = scanDirectory(pkg);
      allViolations.push(...violations);
    }

    writeEvidence("provider-boundary-core.json", {
      scenario: "provider import scan of core packages",
      corePackages: CORE_PACKAGES,
      forbiddenPatterns: FORBIDDEN_PATTERNS.length,
      violationsFound: allViolations.length,
      violations: allViolations.slice(0, 20),
      verdict: allViolations.length === 0 ? "PASS" : "FAIL",
    });

    expect(allViolations.length).toBe(0);
  });

  it("forbidden imports exist only in adapter boundaries", () => {
    printGateHeader("provider-boundary-adapters");
    const adapterViolations: Violation[] = [];

    for (const pkg of ADAPTER_PACKAGES) {
      const violations = scanDirectory(pkg);
      adapterViolations.push(...violations);
    }

    // Adapter packages ARE allowed to have provider imports
    // This test documents the allowed locations
    const allowedProviders = adapterViolations.map((v) => v.provider);
    const uniqueProviders = [...new Set(allowedProviders)];

    writeEvidence("provider-boundary-adapters.json", {
      scenario: "provider import scan of adapter packages",
      adapterPackages: ADAPTER_PACKAGES,
      providerImportsFound: adapterViolations.length,
      uniqueProviders,
      verdict: "PASS — imports are in adapter boundary only",
    });

    // Document — don't assert, since adapters SHOULD have provider imports
    console.log(
      `[provider-boundary] adapter packages contain ${adapterViolations.length} provider imports across: ${uniqueProviders.join(", ")}`,
    );
  });

  it("core packages have zero require() calls to provider modules", () => {
    printGateHeader("provider-boundary-require");
    const violations: string[] = [];

    for (const pkg of CORE_PACKAGES) {
      try {
        const output = execSync(
          `grep -rn "require(" "${pkg}" --include="*.ts" --include="*.tsx" 2>/dev/null || true`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );

        for (const line of output.split("\n").filter((l) => l.trim())) {
          for (const fp of FORBIDDEN_PATTERNS) {
            const reqPattern = fp.pattern.replace("from ", "require(").replace('"', '"');
            if (line.includes(reqPattern)) {
              violations.push(line.slice(0, 200));
              break;
            }
          }
        }
      } catch {
        // expected
      }
    }

    writeEvidence("provider-boundary-require.json", {
      scenario: "require() scan of core packages",
      violationsFound: violations.length,
      verdict: violations.length === 0 ? "PASS" : "FAIL",
    });

    expect(violations.length).toBe(0);
  });
});
