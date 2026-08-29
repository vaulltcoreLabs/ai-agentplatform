import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Infrastructure Separation — automated boundary enforcement.
 *
 * Architectural rule (see docs/vaulltcore/infrastructure/README.md):
 *
 *   The Agent Engine expresses intent. The execution layer executes it.
 *
 * Core packages (`agent`, `intelligence`, `workflow`, `shared`) must be
 * provider-neutral: they may import the `@vaulltcore/sandbox` INTERFACE but
 * never a concrete provider implementation or a cloud/execution SDK. Provider
 * code lives behind the registry in `packages/sandbox` (vercel/, docker/) and
 * is selected exclusively through `connectSandbox` / `createSandbox`.
 *
 * This test scans real source files so a violation fails CI instead of
 * silently re-coupling the engine to a provider.
 */

const CORE_ROOTS = [
  "packages/agent",
  "packages/intelligence",
  "packages/workflow",
  "packages/shared",
] as const;

/** Control plane API routes consume sandboxes only via the factory. */
const CONTROL_PLANE_ROOTS = ["apps/web/app/api"] as const;

/**
 * Forbidden import specifiers in core/control-plane code:
 *  - any Vercel SDK (`@vercel/*`)
 *  - concrete sandbox provider subpaths (`@vaulltcore/sandbox/vercel|docker`)
 *  - container/cloud/database provider SDKs (dockerode, @cloudflare/*,
 *    postgres/pg/kysely/drizzle) and even the SQLite driver — persistence
 *    belongs exclusively in packages/adapters.
 */
const FORBIDDEN_SPECIFIERS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^@vercel\//,
    reason: "Vercel SDK imported outside packages/sandbox providers",
  },
  {
    pattern: /^@vaulltcore\/sandbox\/(vercel|docker)/,
    reason: "concrete sandbox provider subpath imported outside the registry",
  },
  {
    pattern: /^(dockerode|@cloudflare\/)/,
    reason: "execution/cloud provider SDK imported into a neutral layer",
  },
  {
    pattern: /^(postgres|pg|kysely|drizzle-orm|bun:sqlite)/,
    reason: "database client imported outside packages/adapters",
  },
];

/** Matches static and dynamic import module specifiers. */
const IMPORT_RE =
  /(?:\bimport[\s\S]*?\bfrom\s*|\bimport\s*\(\s*|\bexport\s[\s\S]*?\bfrom\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

function findViolations(
  filePath: string,
  source: string,
): Array<{ specifier: string; reason: string }> {
  const violations: Array<{ specifier: string; reason: string }> = [];

  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? "";
    for (const rule of FORBIDDEN_SPECIFIERS) {
      if (rule.pattern.test(specifier)) {
        violations.push({ specifier, reason: rule.reason });
      }
    }
  }

  return violations.map((v) => ({
    ...v,
    specifier: `${filePath}: ${v.specifier}`,
  }));
}

describe("infrastructure separation — import boundaries", () => {
  it("core packages import no execution/provider SDKs", async () => {
    const allViolations: string[] = [];

    for (const root of CORE_ROOTS) {
      const files = await listSourceFiles(root);
      for (const file of files) {
        const source = await readFile(file, "utf-8");
        for (const violation of findViolations(file, source)) {
          allViolations.push(`${violation.specifier} (${violation.reason})`);
        }
      }
    }

    expect(allViolations).toEqual([]);
  });

  it("control-plane API routes obtain sandboxes only via the factory", async () => {
    const allViolations: string[] = [];

    for (const root of CONTROL_PLANE_ROOTS) {
      const files = await listSourceFiles(root);
      for (const file of files) {
        const source = await readFile(file, "utf-8");
        // The control plane may reference @vaulltcore/sandbox types, but never
        // a concrete provider subpath.
        for (const match of source.matchAll(IMPORT_RE)) {
          const specifier = match[1] ?? "";
          if (/^@vaulltcore\/sandbox\/(vercel|docker)/.test(specifier)) {
            allViolations.push(`${file}: ${specifier}`);
          }
        }
      }
    }

    expect(allViolations).toEqual([]);
  });
});
