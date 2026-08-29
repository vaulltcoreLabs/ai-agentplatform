/**
 * Phase 5 — R2 adapter configuration.
 *
 * Reads ONLY from the environment; values are never logged and never embedded
 * in errors beyond which KEY is missing. This is the single place R2
 * credentials are resolved on Node/Bun/Fly-style runtimes.
 */

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

export const R2_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

export function readR2Config(
  env: Record<string, string | undefined> = process.env,
): R2Config {
  const missing = R2_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `R2 configuration incomplete — missing env keys: ${missing.join(", ")}`,
    );
  }
  return {
    accountId: env.R2_ACCOUNT_ID!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
  };
}

export function hasR2Config(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return R2_ENV_KEYS.every((k) => Boolean(env[k]));
}
