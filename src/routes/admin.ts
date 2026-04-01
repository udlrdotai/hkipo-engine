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

// POST /admin/api/discover
// Manual trigger for HKEXnews scraping
adminRoutes.post("/discover", async (c) => {
  const { discover } = await import("../services/discovery");
  const result = await discover(c.env);
  return c.json(result);
});

// GET /admin/api/prospectus/pending
// Returns prospectuses in pending status, supports ?lang= filter
adminRoutes.get("/prospectus/pending", async (c) => {
  const lang = c.req.query("lang");

  let query = `
    SELECT stock_code, lang, source_url, company_name,
           status, created_at
    FROM prospectus
    WHERE status = 'pending'
  `;
  const params: string[] = [];

  if (lang) {
    query += " AND lang = ?";
    params.push(lang);
  }

  query += " ORDER BY created_at ASC";

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json(rows.results);
});

// POST /admin/api/prospectus
// Submit parsed prospectus data
adminRoutes.post("/prospectus", async (c) => {
  const body = await c.req.json();
  const { stock_code, lang } = body;

  if (!stock_code) {
    return c.json({ error: "stock_code is required" }, 400);
  }
  if (!lang || !["en", "tc"].includes(lang)) {
    return c.json({ error: "lang must be 'en' or 'tc'" }, 400);
  }

  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO prospectus (
      stock_code, lang, source_url, company_name,
      industry, board,
      listing_date, offer_start, offer_end, price_low, price_high,
      currency, net_proceeds, business_summary, dividend_policy,
      offering, timeline, sponsors, financials,
      use_of_proceeds, cornerstone_investors, shareholders,
      risk_factors, financial_risks,
      status, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4,
      ?5, ?6,
      ?7, ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, ?15,
      ?16, ?17, ?18, ?19,
      ?20, ?21, ?22,
      ?23, ?24,
      'parsed', ?25, ?25
    )
    ON CONFLICT(stock_code, lang) DO UPDATE SET
      source_url = ?3, company_name = ?4,
      industry = ?5, board = ?6,
      listing_date = ?7, offer_start = ?8, offer_end = ?9, price_low = ?10, price_high = ?11,
      currency = ?12, net_proceeds = ?13, business_summary = ?14, dividend_policy = ?15,
      offering = ?16, timeline = ?17, sponsors = ?18, financials = ?19,
      use_of_proceeds = ?20, cornerstone_investors = ?21, shareholders = ?22,
      risk_factors = ?23, financial_risks = ?24,
      status = 'parsed', updated_at = ?25
  `).bind(
    stock_code,
    lang,
    body.source_url ?? null,
    body.company_name ?? null,
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
    now,
  ).run();

  return c.json({ ok: true, stock_code, lang });
});

// PATCH /admin/api/prospectus/:stock_code/:lang/status
// Update prospectus status
adminRoutes.patch("/prospectus/:stock_code/:lang/status", async (c) => {
  const stockCode = c.req.param("stock_code");
  const lang = c.req.param("lang");
  const body = await c.req.json();
  const { status } = body;

  if (!["en", "tc"].includes(lang)) {
    return c.json({ error: "lang must be 'en' or 'tc'" }, 400);
  }

  const valid = ["pending", "crawled", "parsed", "failed"];
  if (!status || !valid.includes(status)) {
    return c.json({ error: `status must be one of: ${valid.join(", ")}` }, 400);
  }

  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE prospectus SET status = ?, updated_at = ? WHERE stock_code = ? AND lang = ?"
  ).bind(status, now, stockCode, lang).run();

  if (!result.meta.changes) {
    return c.json({ error: "Prospectus not found" }, 404);
  }

  return c.json({ ok: true, stock_code: stockCode, lang, status });
});
