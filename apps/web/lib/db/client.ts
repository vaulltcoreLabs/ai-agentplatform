import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleClient | null = null;

export const db = new Proxy({} as DrizzleClient, {
  get(_, prop) {
    if (!_db) {
      if (!process.env.POSTGRES_URL) {
        throw new Error("POSTGRES_URL environment variable is required");
      }
      // Neon WebSocket pool (same @neondatabase/serverless package). Unlike
      // neon-http, this driver supports interactive transactions — required by
      // lib/db/sessions.ts and lib/db/workflow-runs.ts (db.transaction()).
      const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
      _db = drizzle(pool, { schema });
    }
    return Reflect.get(_db, prop);
  },
});
