import type { Hono } from "hono";

export function createUsageRouter(app: Hono) {
  app.on("GET", "/api/usage", async (c) => {
    const route = await import("@/app/api/usage/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", "/api/usage/rank", async (c) => {
    const route = await import("@/app/api/usage/rank/route");
    return route.GET(c.req.raw);
  });
}
