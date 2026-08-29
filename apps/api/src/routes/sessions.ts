import type { Hono } from "hono";

export function createSessionsRouter(app: Hono) {
  const base = "/api/sessions";
  const sessionsBase = `${base}/:sessionId`;
  const chatsBase = `${sessionsBase}/chats`;
  const chatBase = `${chatsBase}/:chatId`;
  const messagesBase = `${chatBase}/messages`;
  const msgBase = `${messagesBase}/:messageId`;
  const filesBase = `${sessionsBase}/files`;
  const fileContentBase = `${filesBase}/content`;
  const diffBase = `${sessionsBase}/diff`;
  const diffPatchBase = `${diffBase}/patch`;
  const diffCachedBase = `${diffBase}/cached`;
  const skillsBase = `${sessionsBase}/skills`;
  const devServerBase = `${sessionsBase}/dev-server`;
  const codeEditorBase = `${sessionsBase}/code-editor`;
  const checksFixBase = `${sessionsBase}/checks/fix`;
  const commitMsgBase = `${sessionsBase}/generate-commit-message`;

  // /api/sessions
  app.on("GET", base, async (c) => {
    const route = await import("@/app/api/sessions/route");
    return route.GET(c.req.raw);
  });
  app.on("POST", base, async (c) => {
    const route = await import("@/app/api/sessions/route");
    return route.POST(c.req.raw);
  });

  // /api/sessions/:sessionId
  app.on("GET", sessionsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("PATCH", sessionsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/route");
    return route.PATCH(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("DELETE", sessionsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/route");
    return route.DELETE(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/share
  app.on("POST", `${sessionsBase}/share`, async (_c) => {
    const route = await import("@/app/api/sessions/[sessionId]/share/route");
    return route.POST();
  });
  app.on("DELETE", `${sessionsBase}/share`, async (_c) => {
    const route = await import("@/app/api/sessions/[sessionId]/share/route");
    return route.DELETE();
  });

  // /api/sessions/:sessionId/chats
  app.on("GET", chatsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/chats/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("POST", chatsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/chats/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/chats/:chatId
  app.on("GET", chatBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/route");
    return route.GET(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });
  app.on("PATCH", chatBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/route");
    return route.PATCH(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });
  app.on("DELETE", chatBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/route");
    return route.DELETE(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });

  // /api/sessions/:sessionId/chats/:chatId/fork
  app.on("POST", `${chatBase}/fork`, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/fork/route");
    return route.POST(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });

  // /api/sessions/:sessionId/chats/:chatId/read
  app.on("POST", `${chatBase}/read`, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/read/route");
    return route.POST(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });

  // /api/sessions/:sessionId/chats/:chatId/share
  app.on("GET", `${chatBase}/share`, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/share/route");
    return route.GET(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });
  app.on("POST", `${chatBase}/share`, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/share/route");
    return route.POST(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });
  app.on("DELETE", `${chatBase}/share`, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/share/route");
    return route.DELETE(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });

  // /api/sessions/:sessionId/chats/:chatId/messages
  app.on("POST", messagesBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/messages/route");
    return route.POST(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId }),
    });
  });

  // /api/sessions/:sessionId/chats/:chatId/messages/:messageId
  app.on("DELETE", msgBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const chatId = c.req.param("chatId");
    const messageId = c.req.param("messageId");
    const route =
      await import("@/app/api/sessions/[sessionId]/chats/[chatId]/messages/[messageId]/route");
    return route.DELETE(c.req.raw, {
      params: Promise.resolve({ sessionId, chatId, messageId }),
    });
  });

  // /api/sessions/:sessionId/files
  app.on("GET", filesBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/files/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/files/content
  app.on("GET", fileContentBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/files/content/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/diff
  app.on("GET", diffBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/diff/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/diff/patch
  app.on("GET", diffPatchBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/diff/patch/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/diff/cached
  app.on("GET", diffCachedBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/diff/cached/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/skills
  app.on("GET", skillsBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await import("@/app/api/sessions/[sessionId]/skills/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/dev-server
  app.on("POST", devServerBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/dev-server/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("DELETE", devServerBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/dev-server/route");
    return route.DELETE(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/code-editor
  app.on("GET", codeEditorBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/code-editor/route");
    return route.GET(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("POST", codeEditorBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/code-editor/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
  app.on("DELETE", codeEditorBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/code-editor/route");
    return route.DELETE(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/checks/fix
  app.on("POST", checksFixBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/checks/fix/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });

  // /api/sessions/:sessionId/generate-commit-message
  app.on("POST", commitMsgBase, async (c) => {
    const sessionId = c.req.param("sessionId");
    const route =
      await import("@/app/api/sessions/[sessionId]/generate-commit-message/route");
    return route.POST(c.req.raw, { params: Promise.resolve({ sessionId }) });
  });
}
