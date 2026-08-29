import type { Hono } from "hono";

export function createModelsRouter(app: Hono) {
  app.on("GET", "/api/models", async (c) => {
    const route = await import("@/app/api/models/route");
    return route.GET(c.req.raw);
  });
}
