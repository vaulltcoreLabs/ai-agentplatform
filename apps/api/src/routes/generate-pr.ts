import type { Hono } from "hono";

export function createGeneratePrRouter(app: Hono) {
  app.on("POST", "/api/generate-pr", async (c) => {
    const route = await import("@/app/api/generate-pr/route");
    return route.POST(c.req.raw);
  });
}
