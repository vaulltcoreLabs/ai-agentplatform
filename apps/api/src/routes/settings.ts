import type { Hono } from "hono";

export function createSettingsRouter(app: Hono) {
  const base = "/api/settings";

  app.on("GET", `${base}/preferences`, async (c) => {
    const route = await import("@/app/api/settings/preferences/route");
    return route.GET(c.req.raw);
  });
  app.on("PATCH", `${base}/preferences`, async (c) => {
    const route = await import("@/app/api/settings/preferences/route");
    return route.PATCH(c.req.raw);
  });

  app.on("GET", `${base}/model-variants`, async (c) => {
    const route = await import("@/app/api/settings/model-variants/route");
    return route.GET(c.req.raw);
  });
  app.on("POST", `${base}/model-variants`, async (c) => {
    const route = await import("@/app/api/settings/model-variants/route");
    return route.POST(c.req.raw);
  });
  app.on("PATCH", `${base}/model-variants`, async (c) => {
    const route = await import("@/app/api/settings/model-variants/route");
    return route.PATCH(c.req.raw);
  });
  app.on("DELETE", `${base}/model-variants`, async (c) => {
    const route = await import("@/app/api/settings/model-variants/route");
    return route.DELETE(c.req.raw);
  });
}
