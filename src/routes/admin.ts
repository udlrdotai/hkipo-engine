import { Hono } from "hono";
import type { Env } from "../models/types";

export const adminRoutes = new Hono<{ Bindings: Env }>();

// Auth middleware — verify Bearer token
adminRoutes.use("/*", async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = header.slice(7);
  if (token !== c.env.ADMIN_API_KEY) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

// GET /admin/api/prospectus/pending
// Returns prospectuses in pending status with PDF download URLs from filing table
adminRoutes.get("/prospectus/pending", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT
      p.stock_code,
      p.company_name_en,
      p.company_name_tc,
      p.status,
      p.created_at,
      f.source_url AS pdf_url,
      f.lang
    FROM prospectus p
    LEFT JOIN company co ON co.stock_code = p.stock_code
    LEFT JOIN ipo i ON i.company_id = co.id
    LEFT JOIN filing f ON f.ipo_id = i.id
      AND f.category = 'Listing Document'
    WHERE p.status = 'pending'
    ORDER BY p.created_at ASC
  `).all();

  // Group PDF URLs by stock_code
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows.results) {
    const code = row.stock_code as string;
    if (!map.has(code)) {
      map.set(code, {
        stock_code: row.stock_code,
        company_name_en: row.company_name_en,
        company_name_tc: row.company_name_tc,
        status: row.status,
        created_at: row.created_at,
        pdf_urls: [],
      });
    }
    if (row.pdf_url) {
      (map.get(code)!.pdf_urls as string[]).push(row.pdf_url as string);
    }
  }

  return c.json(Array.from(map.values()));
});

// POST /admin/api/prospectus
// Submit parsed prospectus data
adminRoutes.post("/prospectus", async (c) => {
  const body = await c.req.json();
  const { stock_code } = body;

  if (!stock_code) {
    return c.json({ error: "stock_code is required" }, 400);
  }

  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO prospectus (
      stock_code, company_name_tc, company_name_en, industry, board,
      listing_date, offer_start, offer_end, price_low, price_high,
      currency, net_proceeds, business_summary, dividend_policy,
      offering, timeline, sponsors, financials,
      use_of_proceeds, cornerstone_investors, shareholders,
      risk_factors, financial_risks,
      status, source_pdf_key, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5,
      ?6, ?7, ?8, ?9, ?10,
      ?11, ?12, ?13, ?14,
      ?15, ?16, ?17, ?18,
      ?19, ?20, ?21,
      ?22, ?23,
      'parsed', ?24, ?25, ?25
    )
    ON CONFLICT(stock_code) DO UPDATE SET
      company_name_tc = ?2, company_name_en = ?3, industry = ?4, board = ?5,
      listing_date = ?6, offer_start = ?7, offer_end = ?8, price_low = ?9, price_high = ?10,
      currency = ?11, net_proceeds = ?12, business_summary = ?13, dividend_policy = ?14,
      offering = ?15, timeline = ?16, sponsors = ?17, financials = ?18,
      use_of_proceeds = ?19, cornerstone_investors = ?20, shareholders = ?21,
      risk_factors = ?22, financial_risks = ?23,
      status = 'parsed', source_pdf_key = ?24, updated_at = ?25
  `).bind(
    stock_code,
    body.company_name_tc ?? null,
    body.company_name_en ?? null,
    body.industry ?? null,
    body.board ?? null,
    body.listing_date ?? null,
    body.offer_start ?? null,
    body.offer_end ?? null,
    body.price_low ?? null,
    body.price_high ?? null,
    body.currency ?? null,
    body.net_proceeds ?? null,
    body.business_summary ?? null,
    body.dividend_policy ?? null,
    body.offering ? JSON.stringify(body.offering) : null,
    body.timeline ? JSON.stringify(body.timeline) : null,
    body.sponsors ? JSON.stringify(body.sponsors) : null,
    body.financials ? JSON.stringify(body.financials) : null,
    body.use_of_proceeds ? JSON.stringify(body.use_of_proceeds) : null,
    body.cornerstone_investors ? JSON.stringify(body.cornerstone_investors) : null,
    body.shareholders ? JSON.stringify(body.shareholders) : null,
    body.risk_factors ? JSON.stringify(body.risk_factors) : null,
    body.financial_risks ? JSON.stringify(body.financial_risks) : null,
    body.source_pdf_key ?? null,
    now,
  ).run();

  return c.json({ ok: true, stock_code });
});

// PATCH /admin/api/prospectus/:stock_code/status
// Update prospectus status
adminRoutes.patch("/prospectus/:stock_code/status", async (c) => {
  const stockCode = c.req.param("stock_code");
  const body = await c.req.json();
  const { status } = body;

  const valid = ["pending", "crawled", "parsed", "failed"];
  if (!status || !valid.includes(status)) {
    return c.json({ error: `status must be one of: ${valid.join(", ")}` }, 400);
  }

  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE prospectus SET status = ?, updated_at = ? WHERE stock_code = ?"
  ).bind(status, now, stockCode).run();

  if (!result.meta.changes) {
    return c.json({ error: "Prospectus not found" }, 404);
  }

  return c.json({ ok: true, stock_code: stockCode, status });
});
