import { describe, expect, it, beforeEach } from "bun:test";
import { Resend } from "resend";
import {
  SendEmailSchema,
  sendEmail,
  _resetResendClientForTesting,
} from "./email";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("SendEmailSchema", () => {
  it("rejects empty recipient list", () => {
    const result = SendEmailSchema.safeParse({
      to: [],
      subject: "Hi",
      html: "<p>Hello</p>",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email addresses", () => {
    const result = SendEmailSchema.safeParse({
      to: ["not-an-email"],
      subject: "Hi",
      html: "<p>Hello</p>",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid input with html", () => {
    const result = SendEmailSchema.safeParse({
      to: ["user@example.com"],
      subject: "Test",
      html: "<p>Body</p>",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid input with text", () => {
    const result = SendEmailSchema.safeParse({
      to: ["user@example.com"],
      subject: "Test",
      text: "Body",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional from, replyTo", () => {
    const result = SendEmailSchema.safeParse({
      from: "Custom <custom@example.com>",
      to: ["user@example.com"],
      subject: "Test",
      html: "<p>Body</p>",
      replyTo: ["reply@example.com"],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendEmail unit tests (mocked Resend client)
// ---------------------------------------------------------------------------

function createMockResendClient(
  overrides?: Partial<InstanceType<typeof Resend>["emails"]>,
): Resend {
  return {
    emails: {
      send:
        overrides?.send ??
        (async () => ({ data: { id: "msg_123" }, error: null, headers: null })),
    },
  } as unknown as Resend;
}

describe("sendEmail", () => {
  beforeEach(() => {
    _resetResendClientForTesting();
  });

  it("returns error for invalid input", async () => {
    const result = await sendEmail(
      { to: [], subject: "", html: "" },
      createMockResendClient(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid email input");
    }
  });

  it("returns error when neither html nor text provided", async () => {
    const result = await sendEmail(
      { to: ["user@example.com"], subject: "Test" },
      createMockResendClient(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("html or text body is required");
    }
  });

  it("succeeds with valid html input", async () => {
    const result = await sendEmail(
      {
        to: ["user@example.com"],
        subject: "Welcome",
        html: "<p>Welcome!</p>",
      },
      createMockResendClient(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe("msg_123");
    }
  });

  it("returns error when Resend API returns error", async () => {
    const client = createMockResendClient({
      send: async () => ({
        data: null,
        error: {
          message: "Invalid API key",
          name: "validation_error",
          statusCode: 401,
        },
        headers: null,
      }),
    });
    const result = await sendEmail(
      {
        to: ["user@example.com"],
        subject: "Test",
        html: "<p>Hi</p>",
      },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid API key");
    }
  });

  it("returns error when send throws", async () => {
    const client = createMockResendClient({
      send: async () => {
        throw new Error("Network failure");
      },
    });
    const result = await sendEmail(
      {
        to: ["user@example.com"],
        subject: "Test",
        html: "<p>Hi</p>",
      },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Network failure");
    }
  });
});
