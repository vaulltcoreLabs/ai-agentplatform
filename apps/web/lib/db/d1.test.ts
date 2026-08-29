import { describe, expect, it, beforeEach } from "bun:test";
import { getD1Config, _resetD1ClientForTesting } from "./d1";

// ---------------------------------------------------------------------------
// Configuration tests
// ---------------------------------------------------------------------------

describe("getD1Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetD1ClientForTesting();
  });

  it("returns config when all env vars are set", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
    process.env.D1_DATABASE_ID = "test-db-id";
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";

    const config = getD1Config();
    expect(config.accountId).toBe("test-account-id");
    expect(config.databaseId).toBe("test-db-id");
    expect(config.apiToken).toBe("test-api-token");
  });

  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.D1_DATABASE_ID = "test-db-id";
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";

    expect(() => getD1Config()).toThrow("CLOUDFLARE_ACCOUNT_ID is not set");
  });

  it("throws when D1_DATABASE_ID is missing", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
    delete process.env.D1_DATABASE_ID;
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";

    expect(() => getD1Config()).toThrow("D1_DATABASE_ID is not set");
  });

  it("throws when CLOUDFLARE_API_TOKEN is missing", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
    process.env.D1_DATABASE_ID = "test-db-id";
    delete process.env.CLOUDFLARE_API_TOKEN;

    expect(() => getD1Config()).toThrow("CLOUDFLARE_API_TOKEN is not set");
  });

  it("trims whitespace from env vars", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "  test-account-id  ";
    process.env.D1_DATABASE_ID = "  test-db-id  ";
    process.env.CLOUDFLARE_API_TOKEN = "  test-api-token  ";

    const config = getD1Config();
    expect(config.accountId).toBe("test-account-id");
    expect(config.databaseId).toBe("test-db-id");
    expect(config.apiToken).toBe("test-api-token");
  });
});
