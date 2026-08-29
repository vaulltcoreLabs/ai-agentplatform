import type { Hono } from "hono";

export function createTranscribeRouter(app: Hono) {
  app.on("POST", "/api/transcribe", async (c) => {
    const route = await import("@/app/api/transcribe/route");
    return route.POST(c.req.raw);
  });
}
