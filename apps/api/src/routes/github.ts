import type { Hono } from "hono";

export function createGithubRouter(app: Hono) {
  const base = "/api/github";

  app.on("POST", `${base}/app/callback`, async (c) => {
    const route = await import("@/app/api/github/app/callback/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/app/install`, async (c) => {
    const route = await import("@/app/api/github/app/install/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/branches`, async (c) => {
    const route = await import("@/app/api/github/branches/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/connection-status`, async (c) => {
    const route = await import("@/app/api/github/connection-status/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/installations`, async (c) => {
    const route = await import("@/app/api/github/installations/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/installations/repos`, async (c) => {
    const route = await import("@/app/api/github/installations/repos/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/orgs`, async (c) => {
    const route = await import("@/app/api/github/orgs/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/orgs/install-status`, async (c) => {
    const route = await import("@/app/api/github/orgs/install-status/route");
    return route.GET(c.req.raw);
  });

  app.on("POST", `${base}/create-repo`, async (c) => {
    const route = await import("@/app/api/github/create-repo/route");
    return route.POST(c.req.raw);
  });

  app.on("GET", `${base}/post-link`, async (c) => {
    const route = await import("@/app/api/github/post-link/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/user`, async (c) => {
    const route = await import("@/app/api/github/user/route");
    return route.GET(c.req.raw);
  });

  app.on("POST", `${base}/webhook`, async (c) => {
    const route = await import("@/app/api/github/webhook/route");
    return route.POST(c.req.raw);
  });
}
