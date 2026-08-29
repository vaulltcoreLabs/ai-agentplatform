import type { Hono } from "hono";

export function createArtifactsRouter(app: Hono) {
  const base = "/api/artifacts";

  // GET /api/artifacts?runId=... — list artifacts for a run
  app.on("GET", base, async (c) => {
    const route = await import("@/app/api/artifacts/route");
    return route.GET(c.req.raw);
  });

  // POST /api/artifacts/reserve — reserve artifact upload
  app.on("POST", `${base}/reserve`, async (c) => {
    const route = await import("@/app/api/artifacts/reserve/route");
    return route.POST(c.req.raw);
  });

  // POST /api/artifacts/confirm — confirm artifact upload
  app.on("POST", `${base}/confirm`, async (c) => {
    const route = await import("@/app/api/artifacts/confirm/route");
    return route.POST(c.req.raw);
  });

  // GET /api/artifacts/download/:artifactId — download artifact
  app.on("GET", `${base}/download/:artifactId`, async (c) => {
    const artifactId = c.req.param("artifactId");
    const route = await import(
      "@/app/api/artifacts/download/[artifactId]/route"
    );
    return route.GET(c.req.raw, {
      params: Promise.resolve({ artifactId }),
    });
  });

  // DELETE /api/artifacts/:artifactId — delete artifact
  app.on("DELETE", `${base}/:artifactId`, async (c) => {
    const artifactId = c.req.param("artifactId");
    const route = await import("@/app/api/artifacts/[artifactId]/route");
    return route.DELETE(c.req.raw, {
      params: Promise.resolve({ artifactId }),
    });
  });
}
