import { Hono } from "hono";
import type { Env } from "../models/types";
import { parseFiling } from "../services/parser";

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

// Get parsed markdown content of a filing from R2
filingRoutes.get("/:id/content", async (c) => {
  const id = c.req.param("id");

  const filing = await c.env.DB.prepare(
    "SELECT markdown_key FROM filing WHERE id = ?"
  ).bind(id).first<{ markdown_key: string | null }>();

  if (!filing) return c.json({ error: "Filing not found" }, 404);
  if (!filing.markdown_key) return c.json({ error: "Not yet parsed" }, 404);

  const object = await c.env.BUCKET.get(filing.markdown_key);
  if (!object) return c.json({ error: "Content not found in storage" }, 404);

  const markdown = await object.text();
  return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

// Trigger parsing for a specific filing
filingRoutes.post("/:id/parse", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid filing ID" }, 400);

  try {
    const markdownKey = await parseFiling(c.env, id);
    return c.json({ ok: true, filing_id: id, markdown_key: markdownKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[filing] Parse failed for ${id}:`, message);
    return c.json({ error: message }, 500);
  }
});
