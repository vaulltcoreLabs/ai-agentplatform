import type { Hono } from "hono";

export function createChatRouter(app: Hono) {
  const base = "/api/chat";

  app.on("POST", base, async (c) => {
    const route = await import("@/app/api/chat/route");
    return route.POST(c.req.raw);
  });

  app.on("GET", `${base}/:chatId/stream`, async (c) => {
    const chatId = c.req.param("chatId");
    const route = await import("@/app/api/chat/[chatId]/stream/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ chatId }) });
  });

  app.on("POST", `${base}/:chatId/stop`, async (c) => {
    const chatId = c.req.param("chatId");
    const route = await import("@/app/api/chat/[chatId]/stop/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ chatId }) });
  });
}
