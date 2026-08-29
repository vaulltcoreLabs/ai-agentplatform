import type { Hono } from "hono";

export function createAuthRouter(app: Hono) {
  app.on("GET", "/api/auth/info", (c) => {
    return import("@/app/api/auth/info/route").then((m) => m.GET(c.req.raw));
  });
}
