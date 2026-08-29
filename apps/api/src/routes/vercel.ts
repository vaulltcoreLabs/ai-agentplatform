import type { Hono } from "hono";

export function createVercelRouter(app: Hono) {
  app.on("GET", "/api/vercel/repo-projects", async (c) => {
    const route = await import("@/app/api/vercel/repo-projects/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", "/api/vercel/projects/:idOrName/env", async (_c) => {
    const route =
      await import("@/app/api/vercel/projects/[idOrName]/env/route");
    return route.GET();
  });
}
