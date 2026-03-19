import { Hono } from "hono";
import type { Env } from "../models/types";

export const ipoRoutes = new Hono<{ Bindings: Env }>();

// List IPOs with optional status filter
ipoRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const board = c.req.query("board");

  let query = `
    SELECT ipo.*, company.name_en, company.name_tc, company.stock_code
    FROM ipo
    JOIN company ON ipo.company_id = company.id
    WHERE 1=1
  `;
  const params: string[] = [];

  if (status) {
    query += " AND ipo.status = ?";
    params.push(status);
  }
  if (board) {
    query += " AND ipo.board = ?";
    params.push(board);
  }

  query += " ORDER BY ipo.updated_at DESC";

  const result = await c.env.DB.prepare(query).bind(...params).all();
  return c.json(result.results);
});

// Get single IPO with filings
ipoRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");

  const ipo = await c.env.DB.prepare(`
    SELECT ipo.*, company.name_en, company.name_tc, company.stock_code
    FROM ipo
    JOIN company ON ipo.company_id = company.id
    WHERE ipo.id = ?
  `).bind(id).first();

  if (!ipo) return c.json({ error: "IPO not found" }, 404);

  const filings = await c.env.DB.prepare(`
    SELECT * FROM filing WHERE ipo_id = ? ORDER BY discovered_at DESC
  `).bind(id).all();

  return c.json({ ...ipo, filings: filings.results });
});
