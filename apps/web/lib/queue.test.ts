import { describe, expect, it, beforeEach } from "bun:test";
import { getCloudflareClient, _resetQueueClientForTesting } from "./queue";

// ---------------------------------------------------------------------------
// Client singleton tests
// ---------------------------------------------------------------------------

describe("getCloudflareClient", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetQueueClientForTesting();
  });

  it("returns a Cloudflare client when API token is set", () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const client = getCloudflareClient();
    expect(client).toBeDefined();
  });

  it("throws when CLOUDFLARE_API_TOKEN is missing", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(() => getCloudflareClient()).toThrow(
      "CLOUDFLARE_API_TOKEN is not set",
    );
  });

  it("caches the client instance across calls", () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const first = getCloudflareClient();
    const second = getCloudflareClient();
    expect(first).toBe(second);
  });

  it("returns fresh instance after reset", () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const first = getCloudflareClient();
    _resetQueueClientForTesting();
    const second = getCloudflareClient();
    expect(first).not.toBe(second);
  });
});
