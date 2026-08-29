import type { CreateEmailOptions } from "resend";
import { Resend } from "resend";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const EMAIL_FROM_DEFAULT = "Vaulltcore <notifications@vaulltcore.com>";

let clientInstance: Resend | null = null;

export function getResendClient(): Resend {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Add it in Settings → Environment.",
    );
  }

  clientInstance = new Resend(apiKey);
  return clientInstance;
}

/**
 * Reset the cached client instance — only for testing.
 * @internal
 */
export function _resetResendClientForTesting(): void {
  clientInstance = null;
}

// ---------------------------------------------------------------------------
// Email schema
// ---------------------------------------------------------------------------

export const SendEmailSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1).max(998),
  html: z.string().optional(),
  text: z.string().optional(),
  replyTo: z.array(z.string().email()).optional(),
});

export type SendEmailInput = z.infer<typeof SendEmailSchema>;

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendEmail(
  input: SendEmailInput,
  client?: Resend,
): Promise<SendEmailResult> {
  const parsed = SendEmailSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid email input: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }

  const data = parsed.data;

  if (!data.html && !data.text) {
    return {
      ok: false,
      error: "Either html or text body is required",
    };
  }

  try {
    const resend = client ?? getResendClient();
    const payload: Record<string, unknown> = {
      from: data.from ?? EMAIL_FROM_DEFAULT,
      to: data.to,
      subject: data.subject,
    };
    if (data.html) payload.html = data.html;
    if (data.text) payload.text = data.text;
    if (data.replyTo) {
      payload.replyTo = data.replyTo.map((addr) => ({ address: addr }));
    }
    // Zod validation above guarantees at least one of html/text is present,
    // satisfying Resend's RequireAtLeastOne constraint.
    const result = await resend.emails.send(
      payload as unknown as CreateEmailOptions,
    );

    if (result.error) {
      return {
        ok: false,
        error: result.error.message ?? "Resend API error",
      };
    }

    return { ok: true, id: result.data?.id ?? "" };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error sending email";
    return { ok: false, error: message };
  }
}
