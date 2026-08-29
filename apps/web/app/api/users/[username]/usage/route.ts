import { getPublicUsageProfile } from "@/lib/db/public-usage-profile";
import { parsePublicUsageDate } from "@/lib/usage/date-range";

type RouteContext = {
  params: Promise<{ username: string }>;
};

export async function GET(req: Request, context: RouteContext) {
  const { username } = await context.params;
  const { searchParams } = new URL(req.url);
  const rawDate = searchParams.get("date");
  const date =
    typeof rawDate === "string" && rawDate.length > 0 ? rawDate : null;

  if (date !== null) {
    const parsed = parsePublicUsageDate(date);
    if (!parsed.ok) {
      return Response.json({ error: "Invalid date" }, { status: 400 });
    }
  }

  const profile = await getPublicUsageProfile(username, date);

  if (!profile) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({ profile });
}
