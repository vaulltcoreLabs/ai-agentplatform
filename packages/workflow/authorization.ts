/**
 * Vaulltcore Durable Execution — authorization gate.
 *
 * `authorize` is the single, mandatory gate for every tenant-scoped durable
 * operation (submit, getJob, cancel, retry, stream, events, checkpoints,
 * administrative ops). It operates on the invariant identity
 * `tenantId + resourceId`: no operation is permitted on a resource whose
 * tenant differs from the caller, regardless of whether the caller knows the
 * resource identifier.
 *
 * This module additionally centralizes a small set of typed authorization
 * errors so the runtime and transport layers can produce consistent, safe
 * rejection responses without leaking resource existence.
 */

import type { TenantId } from "./identity";

/** Thrown when a tenant attempts to act on a resource it does not own. */
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: "cross_tenant" | "unauthorized" | "tenant_unknown",
    readonly callerTenant?: TenantId,
    readonly resourceTenant?: TenantId,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * The single authorization predicate. Returns true only when the caller tenant
 * equals the resource tenant. Never trusts a resource id alone.
 */
export function authorize(
  callerTenantId: TenantId,
  resourceTenantId: TenantId,
): boolean {
  return callerTenantId === resourceTenantId;
}

/**
 * Authorize a tenant-scoped operation, throwing `AuthorizationError` on
 * failure. Use at the top of every durable operation.
 */
export function assertAuthorized(
  callerTenantId: TenantId,
  resourceTenantId: TenantId,
  operation: string,
): void {
  if (!authorize(callerTenantId, resourceTenantId)) {
    throw new AuthorizationError(
      `Cross-tenant ${operation} denied: caller ${callerTenantId} cannot access resource of ${resourceTenantId}`,
      "cross_tenant",
      callerTenantId,
      resourceTenantId,
    );
  }
}

/**
 * Authorize a submit. The tenant must be registered (known) before any work is
 * accepted. Unregistered tenants are rejected before any durable state is
 * touched.
 */
export function assertTenantKnown(
  knownTenantIds: ReadonlySet<string>,
  callerTenantId: TenantId,
): void {
  if (!knownTenantIds.has(callerTenantId)) {
    throw new AuthorizationError(
      `Unknown tenant ${callerTenantId} may not submit work`,
      "tenant_unknown",
      callerTenantId,
    );
  }
}
