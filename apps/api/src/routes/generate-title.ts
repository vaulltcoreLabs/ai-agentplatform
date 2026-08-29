import type { Hono } from "hono";

export function createGenerateTitleRouter(app: Hono) {
  app.on("POST", "/api/generate-title", async (c) => {
    const route = await import("@/app/api/generate-title/route");
    return route.POST(c.req.raw);
  });
}
