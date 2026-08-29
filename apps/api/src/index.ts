import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { auth } from "@/lib/auth/config";
import { createAuthRouter } from "./routes/auth";
import { createChatRouter } from "./routes/chat";
import { createGithubRouter } from "./routes/github";
import { createSandboxRouter } from "./routes/sandbox";
import { createSessionsRouter } from "./routes/sessions";
import { createSettingsRouter } from "./routes/settings";
import { createModelsRouter } from "./routes/models";
import { createUsageRouter } from "./routes/usage";
import { createSharedRouter } from "./routes/shared";
import { createUsersRouter } from "./routes/users";
import { createReposRouter } from "./routes/repos";
import { createVercelRouter } from "./routes/vercel";
import { createTranscribeRouter } from "./routes/transcribe";
import { createGenerateTitleRouter } from "./routes/generate-title";
import { createGeneratePrRouter } from "./routes/generate-pr";
import { createArtifactsRouter } from "./routes/artifacts";
import { config } from "./config";

const app = new Hono();

app.use("*", logger());
app.use("*", secureHeaders());
app.use(
  "*",
  cors({
    origin: config.auth.allowedHosts,
    credentials: true,
  }),
);

app.all("/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

createAuthRouter(app);
createChatRouter(app);
createGithubRouter(app);
createSandboxRouter(app);
createSessionsRouter(app);
createSettingsRouter(app);
createModelsRouter(app);
createUsageRouter(app);
createSharedRouter(app);
createUsersRouter(app);
createReposRouter(app);
createVercelRouter(app);
createTranscribeRouter(app);
createGenerateTitleRouter(app);
createGeneratePrRouter(app);
createArtifactsRouter(app);

app.get("/health", (c) => c.json({ status: "ok" }));

const port = Number(process.env.PORT ?? 3001);

console.log(`Hono server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
