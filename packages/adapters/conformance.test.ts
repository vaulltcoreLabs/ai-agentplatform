/**
 * Phase 4.6 — conformance suite execution.
 *
 * The SAME semantic tests run against every backend:
 *  - MemorySharedBackend (deterministic single-process reference)
 *    → distributed section skipped: one object cannot be two workers, by
 *      design. It is the reference, not a distributed implementation.
 *  - SqliteSharedBackend with TWO independent connections on one file
 *    → full suite including the distributed section.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySharedBackend } from "@vaulltcore/workflow";
import { SqliteSharedBackend } from "./sqlite-backend";
import {
  describeSharedBackendConformance,
  type BackendFactory,
} from "./conformance";

describeSharedBackendConformance({
  name: "MemorySharedBackend (single-process reference)",
  create: () => new MemorySharedBackend(),
  dispose: () => undefined,
} satisfies BackendFactory);

let dir: string | undefined;

function freshDbPath(): string {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "vc-conf-"));
  return join(dir, `${crypto.randomUUID()}.db`);
}

describeSharedBackendConformance({
  name: "SqliteSharedBackend (independent connections)",
  create: () => new SqliteSharedBackend(freshDbPath()),
  createPair: () => {
    const path = freshDbPath();
    // Two SEPARATE connections to one durable file — the honest meaning of
    // "two workers" at this layer.
    return [new SqliteSharedBackend(path), new SqliteSharedBackend(path)];
  },
  dispose: () => undefined,
} satisfies BackendFactory);
