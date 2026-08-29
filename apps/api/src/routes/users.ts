import type { Hono } from "hono";

export function createUsersRouter(app: Hono) {
  app.on("GET", "/api/users/:username/usage", async (c) => {
    const username = c.req.param("username");
    const route = await import("@/app/api/users/[username]/usage/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ username }) });
  });
}
