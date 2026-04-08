import type { Env } from "../models/types";

// ---------------------------------------------------------------------------
// HKEXnews "Predefined Search" JSON endpoint
// ---------------------------------------------------------------------------
//
// This is the AJAX endpoint behind
//   https://www1.hkexnews.hk/search/predefineddoc.xhtml?lang=en
// when the "Prospectuses" category is selected.
//
// Params:
//   predefineddocuments=6   → Prospectuses
//   period=SevenDays        → last 7 days (also supports `today`)
//   rowRange=100            → max rows
//   lang=en | zh            → English / Traditional Chinese. Anything else
//                             (including "C") silently falls back to English.
//
// Returns JSON like:
//   { "result": "[{...}, ...]", "recordCnt": N, ... }
// where each row has: STOCK_CODE, STOCK_NAME, TITLE, SHORT_TEXT,
// DATE_TIME, FILE_LINK (relative path under www1.hkexnews.hk).
const HKEX_PREDEF_PROSPECTUS = (lang: "en" | "zh") =>
  `https://www1.hkexnews.hk/search/predefinedSearch.do?sortDir=0&sortByOptions=DateTime&period=SevenDays&predefineddocuments=6&rowRange=100&lang=${lang}`;

// ---------------------------------------------------------------------------
// Public entry point – called by Cron Trigger
// ---------------------------------------------------------------------------

/**
 * Discover new IPO prospectuses from HKEXnews.
 * Called by Cron Trigger on schedule.
 *
 * Hits the predefinedSearch.do JSON API for the Prospectuses category in
 * both English and Traditional Chinese, merges company names by stock code,
 * and persists new filings to D1.
 */
export async function discover(env: Env): Promise<DiscoverResult> {
  const [enRows, tcRows] = await Promise.all([
    fetchPredefinedProspectus("en"),
    fetchPredefinedProspectus("zh"),
  ]);

  // Build stock_code -> { en, tc } name map by joining EN and TC rows.
  const nameMap = new Map<string, CompanyNamePair>();
  for (const r of enRows) {
    const cur = nameMap.get(r.stockCode) ?? { en: "", tc: "" };
    if (!cur.en) cur.en = r.stockName;
    nameMap.set(r.stockCode, cur);
  }
  for (const r of tcRows) {
    const cur = nameMap.get(r.stockCode) ?? { en: "", tc: "" };
    if (!cur.tc) cur.tc = r.stockName;
    nameMap.set(r.stockCode, cur);
  }

  // Flatten EN + TC rows into DiscoveredFiling[]. Each row has its own
  // FILE_LINK (en/tc PDFs are different files), so we keep both.
  const filings: DiscoveredFiling[] = [];
  for (const r of enRows) {
    const pair = nameMap.get(r.stockCode) ?? { en: r.stockName, tc: "" };
    filings.push(toFiling(r, pair, "en"));
  }
  for (const r of tcRows) {
    const pair = nameMap.get(r.stockCode) ?? { en: "", tc: r.stockName };
    filings.push(toFiling(r, pair, "tc"));
  }

  // De-duplicate by source_url
  const seen = new Set<string>();
  const unique: DiscoveredFiling[] = [];
  for (const f of filings) {
    const key = normaliseUrl(f.sourceUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  // Persist — isolate failures so one bad row doesn't kill the whole run.
  let inserted = 0;
  let failed = 0;
  for (const item of unique) {
    try {
      const didInsert = await persistFiling(env, item);
      if (didInsert) inserted++;
    } catch (err) {
      failed++;
      console.error(
        `[discovery] persistFiling failed for ${item.stockCode} ${item.sourceUrl}:`,
        err,
      );
    }
  }

  return {
    parsed: { en: enRows.length, tc: tcRows.length },
    newFilings: inserted,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Source: predefinedSearch.do JSON
// ---------------------------------------------------------------------------

interface PredefRow {
  stockCode: string;
  stockName: string;
  title: string;
  shortText: string;
  dateTime: string;
  fileLink: string; // absolute URL
}

interface PredefRawRow {
  STOCK_CODE?: string;
  STOCK_NAME?: string;
  TITLE?: string;
  SHORT_TEXT?: string;
  DATE_TIME?: string;
  FILE_LINK?: string;
  FILE_TYPE?: string;
}

async function fetchPredefinedProspectus(
  lang: "en" | "zh",
): Promise<PredefRow[]> {
  const url = HKEX_PREDEF_PROSPECTUS(lang);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "hkipo-engine/0.1",
        Accept: "application/json,*/*",
        Referer: "https://www1.hkexnews.hk/search/predefineddoc.xhtml",
      },
    });
    if (!resp.ok) {
      console.error(`[discovery] predefinedSearch ${lang} HTTP ${resp.status}`);
      return [];
    }
    const body = (await resp.json()) as { result?: string };
    if (!body.result) return [];
    const rows = JSON.parse(body.result) as PredefRawRow[];
    return rows
      .filter((r) => r.STOCK_CODE && r.FILE_LINK && r.FILE_TYPE === "PDF")
      .map((r) => ({
        stockCode: String(r.STOCK_CODE).trim(),
        stockName: (r.STOCK_NAME ?? "").trim(),
        title: (r.TITLE ?? "").trim(),
        shortText: (r.SHORT_TEXT ?? "").replace(/<br\s*\/?>/gi, " ").trim(),
        dateTime: (r.DATE_TIME ?? "").trim(),
        fileLink: absolutiseUrl(r.FILE_LINK!),
      }));
  } catch (err) {
    console.error(`[discovery] predefinedSearch ${lang} error:`, err);
    return [];
  }
}

function absolutiseUrl(path: string): string {
  if (/^https?:/i.test(path)) return path;
  if (path.startsWith("/")) return "https://www1.hkexnews.hk" + path;
  return "https://www1.hkexnews.hk/" + path;
}

function toFiling(
  row: PredefRow,
  names: CompanyNamePair,
  lang: "en" | "tc",
): DiscoveredFiling {
  return {
    companyNameEn: names.en,
    companyNameTc: names.tc,
    stockCode: row.stockCode,
    board: "Main",
    lang,
    category: "Listing Document",
    title: row.title || "Prospectus",
    sourceUrl: row.fileLink,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** @returns true if a new filing row was inserted. */
async function persistFiling(
  env: Env,
  item: DiscoveredFiling,
): Promise<boolean> {
  // Skip if we already have this filing (by source_url)
  const existing = await env.DB.prepare(
    "SELECT id FROM filing WHERE source_url = ?",
  )
    .bind(item.sourceUrl)
    .first();

  if (existing) return false;

  // Upsert company — prefer stock_code match, fall back to name match
  let company: { id: number } | null = null;

  if (item.stockCode) {
    company = await env.DB.prepare(
      "SELECT id FROM company WHERE stock_code = ?",
    )
      .bind(item.stockCode)
      .first<{ id: number }>();
  }

  if (!company && item.companyNameEn) {
    company = await env.DB.prepare(
      "SELECT id FROM company WHERE name_en = ?",
    )
      .bind(item.companyNameEn)
      .first<{ id: number }>();
  }

  if (!company && item.companyNameTc) {
    company = await env.DB.prepare(
      "SELECT id FROM company WHERE name_tc = ?",
    )
      .bind(item.companyNameTc)
      .first<{ id: number }>();
  }

  if (!company) {
    const nameEn = item.companyNameEn || item.stockCode || "Unknown";
    const res = await env.DB.prepare(
      "INSERT INTO company (name_en, name_tc, stock_code) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(nameEn, item.companyNameTc || "", item.stockCode || null)
      .first<{ id: number }>();
    company = res!;
  } else {
    // Back-fill names / stock_code if we now have them
    if (item.companyNameEn) {
      await env.DB.prepare(
        "UPDATE company SET name_en = ? WHERE id = ? AND (name_en IS NULL OR name_en = '' OR name_en = 'Unknown')",
      )
        .bind(item.companyNameEn, company.id)
        .run();
    }
    if (item.companyNameTc) {
      await env.DB.prepare(
        "UPDATE company SET name_tc = ? WHERE id = ? AND (name_tc IS NULL OR name_tc = '')",
      )
        .bind(item.companyNameTc, company.id)
        .run();
    }
    if (item.stockCode) {
      await env.DB.prepare(
        "UPDATE company SET stock_code = ? WHERE id = ? AND stock_code IS NULL",
      )
        .bind(item.stockCode, company.id)
        .run();
    }
  }

  // Upsert IPO
  let ipo = await env.DB.prepare(
    "SELECT id FROM ipo WHERE company_id = ? AND board = ?",
  )
    .bind(company.id, item.board)
    .first<{ id: number }>();

  if (!ipo) {
    const res = await env.DB.prepare(
      "INSERT INTO ipo (company_id, board) VALUES (?, ?) RETURNING id",
    )
      .bind(company.id, item.board)
      .first<{ id: number }>();
    ipo = res!;
  }

  // Insert filing
  await env.DB.prepare(
    "INSERT INTO filing (ipo_id, lang, category, title, source_url) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(ipo.id, item.lang, item.category, item.title, item.sourceUrl)
    .run();

  // Ensure prospectus record exists (pending status for VPS to pick up)
  if (item.stockCode && item.category === "Listing Document") {
    const companyName =
      item.lang === "tc" ? item.companyNameTc : item.companyNameEn;
    await env.DB.prepare(
      `INSERT INTO prospectus (stock_code, lang, source_url, company_name, board)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(stock_code, lang) DO NOTHING`,
    )
      .bind(
        item.stockCode,
        item.lang,
        item.sourceUrl,
        companyName || null,
        item.board,
      )
      .run();
  }

  console.log(
    `[discovery] New filing: ${item.stockCode} ${item.companyNameEn || item.companyNameTc} – ${item.title}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoverResult {
  parsed: { en: number; tc: number };
  newFilings: number;
  failed: number;
}

interface DiscoveredFiling {
  companyNameEn: string;
  companyNameTc: string;
  stockCode: string;
  board: "Main";
  lang: "en" | "tc";
  category: string;
  title: string;
  sourceUrl: string;
}

interface CompanyNamePair {
  en: string;
  tc: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseUrl(url: string): string {
  return url
    .replace(/^https?:/, "https:")
    .replace(/\/+$/, "")
    .trim();
}
