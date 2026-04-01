import { Hono } from "hono";
import type { Env } from "./models/types";
import { ipoRoutes } from "./routes/ipo";
import { filingRoutes } from "./routes/filing";
import { adminRoutes } from "./routes/admin";
import { discover } from "./services/discovery";

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/", (c) => c.json({ name: "hkipo-engine", status: "ok" }));

// API routes
app.route("/api/ipo", ipoRoutes);
app.route("/api/filing", filingRoutes);
app.route("/admin/api", adminRoutes);

// Cron trigger handler
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(discover(env));
  },
};
