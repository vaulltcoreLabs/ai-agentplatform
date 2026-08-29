import {
  parseUsageDateRange,
  type UsageDateRange,
} from "@/lib/usage/date-range";

export type UsageQueryRange = UsageDateRange | null;

export function parseUsageQueryRange(
  req: Request,
): { ok: true; range: UsageQueryRange } | { ok: false; response: Response } {
  const parsed = parseUsageDateRange({
    from: new URL(req.url).searchParams.get("from"),
    to: new URL(req.url).searchParams.get("to"),
  });

  if (!parsed.ok) {
    return {
      ok: false,
      response: Response.json({ error: parsed.error }, { status: 400 }),
    };
  }

  return {
    ok: true,
    range: parsed.range,
  };
}
