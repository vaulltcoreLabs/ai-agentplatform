import type { Hono } from "hono";

export function createSandboxRouter(app: Hono) {
  const base = "/api/sandbox";

  app.on("POST", base, async (c) => {
    const route = await import("@/app/api/sandbox/route");
    return route.POST(c.req.raw);
  });

  app.on("DELETE", base, async (c) => {
    const route = await import("@/app/api/sandbox/route");
    return route.DELETE(c.req.raw);
  });

  app.on("POST", `${base}/extend`, async (c) => {
    const route = await import("@/app/api/sandbox/extend/route");
    return route.POST(c.req.raw);
  });

  app.on("GET", `${base}/status`, async (c) => {
    const route = await import("@/app/api/sandbox/status/route");
    return route.GET(c.req.raw);
  });

  app.on("GET", `${base}/reconnect`, async (c) => {
    const route = await import("@/app/api/sandbox/reconnect/route");
    return route.GET(c.req.raw);
  });

  app.on("POST", `${base}/snapshot`, async (c) => {
    const route = await import("@/app/api/sandbox/snapshot/route");
    return route.POST(c.req.raw);
  });

  app.on("PUT", `${base}/snapshot`, async (c) => {
    const route = await import("@/app/api/sandbox/snapshot/route");
    return route.PUT(c.req.raw);
  });

  app.on("POST", `${base}/activity`, async (c) => {
    const route = await import("@/app/api/sandbox/activity/route");
    return route.POST(c.req.raw);
  });
}
