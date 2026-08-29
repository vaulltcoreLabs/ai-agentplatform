import type { Hono } from "hono";

export function createReposRouter(app: Hono) {
  app.on("POST", "/api/repos/:owner/:repo/create-session", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const route =
      await import("@/app/api/repos/[owner]/[repo]/create-session/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ owner, repo }) });
  });
}
