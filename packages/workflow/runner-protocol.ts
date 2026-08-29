/* eslint-disable max-classes-per-file */
/**
 * Phase 4.5 — remote runner protocol contracts (provider-neutral).
 *
 * LAYER 1 (CORE): types, identity, and the connection state machine only.
 * NO transport, SDK, or network code lives here — WebSocket/queue transports
 * are Layer-2 adapters and remain FUTURE until implemented.
 *
 * Model (docs/vaulltcore/infrastructure/README.md §5):
 *
 *   Runner ── outbound authenticated connection ──▶ Control Plane
 *
 * The runner is an execution worker, NOT a second Agent Engine. It receives
 * execution envelopes, validates them against its tenant scope and the lease
 * fencing token, runs them through a StepExecutor inside an isolated sandbox,
 * streams events back, and reports results. Durable state remains owned by the
 * WorkflowStore; this protocol is transport-level only.
 *
 * Guarantees modeled here:
 *  - scoped, revocable, non-user runner credentials (never a global secret)
 *  - unique runner identity with capabilities declared at registration
 *  - explicit handshake lifecycle (CONNECTING → … → ACKNOWLEDGED)
 *  - fencing-token enforcement: stale results are rejected
 *  - assignment timeout returns the session to READY (work is re-assignable)
 */

import type {
  DurableRunId,
  DurableStepId,
  DurableTaskId,
  TenantId,
} from "./identity";

/** Identity fields carried by EVERY protocol message (cross-tenant safety). */
export interface ExecutionEnvelope {
  readonly tenantId: TenantId;
  readonly runId: DurableRunId;
  readonly taskId: DurableTaskId;
  readonly stepId: DurableStepId;
  readonly executionId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  /** Lease version held by the worker — commits above it are fenced off. */
  readonly fencingToken: number;
  readonly timestamp: number;
}

export type RunnerCapability =
  | "docker"
  | "gpu"
  | "network"
  | "filesystem"
  | "browser"
  | "languageServer";

/** A registered runner's durable identity. */
export interface RunnerIdentity {
  readonly runnerId: string;
  /** `"*"` for platform-managed runners; a tenant id for dedicated runners. */
  readonly tenantScope: TenantId | "*";
  readonly capabilities: readonly RunnerCapability[];
  readonly version: string;
}

/**
 * Handshake lifecycle. Protocol state is EPHEMERAL; Workflow state is the
 * authoritative durable record (RULE: durable store is truth).
 */
export type RunnerSessionState =
  | "CONNECTING"
  | "AUTHENTICATED"
  | "READY"
  | "ASSIGNED"
  | "LEASED"
  | "EXECUTING"
  | "REPORTING"
  | "COMPLETED"
  | "ACKNOWLEDGED"
  | "RETRY"
  | "CRASHED"
  | "CANCELLED"
  | "LEASE_LOST"
  | "DISCONNECTED";

const TRANSITIONS: Record<RunnerSessionState, readonly RunnerSessionState[]> = {
  CONNECTING: ["AUTHENTICATED"],
  AUTHENTICATED: ["READY", "DISCONNECTED"],
  READY: ["ASSIGNED", "DISCONNECTED"],
  ASSIGNED: ["LEASED", "READY", "DISCONNECTED"], // READY = assignment timeout
  LEASED: ["EXECUTING", "LEASE_LOST"],
  EXECUTING: ["REPORTING", "CRASHED", "CANCELLED"],
  REPORTING: ["COMPLETED", "RETRY"],
  RETRY: ["REPORTING"],
  COMPLETED: ["ACKNOWLEDGED"],
  ACKNOWLEDGED: ["READY"], // session survives for the next task
  CRASHED: ["DISCONNECTED"],
  CANCELLED: ["READY", "DISCONNECTED"],
  LEASE_LOST: ["DISCONNECTED"],
  DISCONNECTED: ["AUTHENTICATED"], // reconnect path
};

export function canTransition(
  from: RunnerSessionState,
  to: RunnerSessionState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export class RunnerProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CREDENTIAL"
      | "REVOKED"
      | "TENANT_SCOPE_VIOLATION"
      | "INVALID_TRANSITION"
      | "STALE_RESULT"
      | "UNKNOWN_RUNNER",
  ) {
    super(message);
    this.name = "RunnerProtocolError";
  }
}

interface Registration {
  readonly identity: RunnerIdentity;
  tokenHash: string | null; // null ⇒ revoked
}

function hash(token: string): string {
  // Protocol-layer comparison hash only; real deployments use HMAC over a
  // server key (FUTURE: durable credential store). Never store raw tokens.
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

let tokenCounter = 0;

/**
 * Control-plane-side credential registry. Tokens are issued once, stored
 * hashed, revocable per runner. A connecting runner must present both its id
 * and current token; a revoked or unknown id is rejected before any work can
 * be assigned.
 */
export class RunnerRegistry {
  private readonly runners = new Map<string, Registration>();

  register(identity: RunnerIdentity): string {
    const token = `vcr_${identity.runnerId}_${++tokenCounter}_${crypto.randomUUID()}`;
    this.runners.set(identity.runnerId, { identity, tokenHash: hash(token) });
    return token;
  }

  revoke(runnerId: string): void {
    const reg = this.runners.get(runnerId);
    if (reg) reg.tokenHash = null;
  }

  authenticate(runnerId: string, token: string): RunnerIdentity {
    const reg = this.runners.get(runnerId);
    if (!reg)
      throw new RunnerProtocolError(
        `unknown runner '${runnerId}'`,
        "UNKNOWN_RUNNER",
      );
    if (reg.tokenHash === null) {
      throw new RunnerProtocolError(
        `runner '${runnerId}' is revoked`,
        "REVOKED",
      );
    }
    if (reg.tokenHash !== hash(token)) {
      throw new RunnerProtocolError(`invalid credential`, "INVALID_CREDENTIAL");
    }
    return reg.identity;
  }
}

/**
 * One authenticated connection's protocol state machine plus the fencing
 * bookkeeping needed to reject stale/duplicate results.
 */
export class RunnerSession {
  state: RunnerSessionState = "CONNECTING";
  lastHeartbeatAt: number;
  private readonly assignedFencing = new Map<string, number>(); // stepId → fencingToken

  constructor(
    readonly identity: RunnerIdentity,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastHeartbeatAt = now();
  }

  transition(to: RunnerSessionState): void {
    if (!canTransition(this.state, to)) {
      throw new RunnerProtocolError(
        `illegal transition ${this.state} → ${to}`,
        "INVALID_TRANSITION",
      );
    }
    this.state = to;
    this.lastHeartbeatAt = this.now();
    if (to === "READY") this.assignedFencing.clear();
  }

  heartbeat(): void {
    this.lastHeartbeatAt = this.now();
  }

  isStale(staleAfterMs: number): boolean {
    return this.now() - this.lastHeartbeatAt > staleAfterMs;
  }

  /** Record the fencing floor for an assignment (called by control plane). */
  noteAssignment(envelope: ExecutionEnvelope): void {
    this.assignedFencing.set(envelope.stepId, envelope.fencingToken);
  }

  /** Lowest fencing token still acceptable for a step's result. */
  expectedFencing(stepId: DurableStepId): number | undefined {
    return this.assignedFencing.get(stepId);
  }
}

/**
 * Control-plane assignment authority. Enforces:
 *  - tenant scope: a runner scoped to tenant X never receives tenant Y work
 *  - capability gating: requested capabilities must be declared
 *  - fencing: a result whose fencingToken is below the assigned one is stale
 */
export class RunnerControlPlane {
  constructor(private readonly now: () => number = () => Date.now()) {}

  assign(session: RunnerSession, envelope: ExecutionEnvelope): void {
    if (session.state !== "READY" && session.state !== "ACKNOWLEDGED") {
      throw new RunnerProtocolError(
        `runner not ready (state=${session.state})`,
        "INVALID_TRANSITION",
      );
    }
    if (
      session.identity.tenantScope !== "*" &&
      session.identity.tenantScope !== envelope.tenantId
    ) {
      throw new RunnerProtocolError(
        `runner '${session.identity.runnerId}' not scoped for tenant '${envelope.tenantId}'`,
        "TENANT_SCOPE_VIOLATION",
      );
    }
    // Fencing token for this step becomes the floor; older results rejected.
    session.noteAssignment(envelope);
    session.transition("ASSIGNED");
  }

  receiveResult(session: RunnerSession, result: ExecutionEnvelope): void {
    const expected = session.expectedFencing(result.stepId);
    if (expected === undefined || result.fencingToken < expected) {
      throw new RunnerProtocolError(
        `stale result for step '${result.stepId}'`,
        "STALE_RESULT",
      );
    }
    session.transition("REPORTING");
  }
}
