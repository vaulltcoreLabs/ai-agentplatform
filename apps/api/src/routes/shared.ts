import type { Hono } from "hono";

export function createSharedRouter(app: Hono) {
  app.on("GET", "/api/shared/:shareId", async (c) => {
    const shareId = c.req.param("shareId");
    const route = await import("@/app/api/shared/[shareId]/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ shareId }) });
  });

  app.on("GET", "/api/shared/:shareId/status", async (c) => {
    const shareId = c.req.param("shareId");
    const route = await import("@/app/api/shared/[shareId]/status/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ shareId }) });
  });

  app.on("GET", "/api/shared/:shareId/markdown", async (c) => {
    const shareId = c.req.param("shareId");
    const route = await import("@/app/api/shared/[shareId]/markdown/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ shareId }) });
  });
}
