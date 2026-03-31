import { Hono } from "hono";
import type { Env } from "../models/types";

export const filingRoutes = new Hono<{ Bindings: Env }>();

// Get filing metadata
filingRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");

  const filing = await c.env.DB.prepare(
    "SELECT * FROM filing WHERE id = ?"
  ).bind(id).first();

  if (!filing) return c.json({ error: "Filing not found" }, 404);
  return c.json(filing);
});
