import type { Env } from "../models/types";

// ---------------------------------------------------------------------------
// URLs for the two HTML "New Listings" pages (www2 – Sitecore CMS)
// ---------------------------------------------------------------------------
const HKEX_NEW_LISTINGS_MAIN_EN =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=en";
const HKEX_NEW_LISTINGS_MAIN_TC =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=zh-HK";

// ---------------------------------------------------------------------------
// Public entry point – called by Cron Trigger
// ---------------------------------------------------------------------------

/**
 * Discover new IPO prospectuses from HKEXnews.
 * Called by Cron Trigger on schedule.
 *
 * Fetches the New Listings HTML pages (Main Board, EN + TC),
 * extracts prospectus PDF links, merges company names by stock code,
 * and persists new filings to D1.
 */
export async function discover(env: Env): Promise<DiscoverResult> {
  // ---- Source 1: New Listings HTML pages ----
  const [mainEn, mainTc] = await Promise.all([
    fetchHtml(HKEX_NEW_LISTINGS_MAIN_EN),
    fetchHtml(HKEX_NEW_LISTINGS_MAIN_TC),
  ]);

  const mainListingsEn = parseNewListingsHtml(mainEn, "Main");
  const mainListingsTc = parseNewListingsHtml(mainTc, "Main");

  // Merge English and TC names by stock code
  const companyNames = buildCompanyNameMap(mainListingsEn, mainListingsTc);

  // Flatten HTML-sourced filings (both EN and TC pages have different PDF links)
  const enFilings = mergeNewListingsToFilings(mainListingsEn, companyNames, "en");
  const tcFilings = mergeNewListingsToFilings(mainListingsTc, companyNames, "tc");
  const filings = [...enFilings, ...tcFilings];

  // De-duplicate by source_url
  const seenUrls = new Set<string>();
  const uniqueFilings: DiscoveredFiling[] = [];
  for (const f of filings) {
    const normUrl = normaliseUrl(f.sourceUrl);
    if (!seenUrls.has(normUrl)) {
      seenUrls.add(normUrl);
      uniqueFilings.push(f);
    }
  }

  // ---- Persist ----
  for (const item of uniqueFilings) {
    await persistFiling(env, item);
  }

  return {
    parsed: {
      mainEn: mainListingsEn.length,
      mainTc: mainListingsTc.length,
    },
    newFilings: uniqueFilings.length,
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function persistFiling(env: Env, item: DiscoveredFiling): Promise<void> {
  // Skip if we already have this filing (by source_url)
  const existing = await env.DB.prepare(
    "SELECT id FROM filing WHERE source_url = ?",
  )
    .bind(item.sourceUrl)
    .first();

  if (existing) return;

  // Upsert company — prefer stock_code match, fall back to name_en match
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
    // Back-fill EN name / TC name / stock_code if we now have them
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
  if (item.stockCode) {
    await env.DB.prepare(
      `INSERT INTO prospectus (stock_code, company_name_en, company_name_tc, board)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stock_code) DO NOTHING`,
    )
      .bind(item.stockCode, item.companyNameEn || null, item.companyNameTc || null, item.board)
      .run();
  }

  console.log(
    `[discovery] New filing: ${item.companyNameEn || item.stockCode} – ${item.title}`,
  );
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface DiscoverResult {
  parsed: { mainEn: number; mainTc: number };
  newFilings: number;
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

/** One row from the "New Listings" HTML table (per stock) */
interface NewListingEntry {
  stockCode: string;
  companyName: string;
  board: "Main";
  prospectusUrls: string[];
}

interface CompanyNamePair {
  en: string;
  tc: string;
}

// ---------------------------------------------------------------------------
// Source 1: New Listings HTML page parsing
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "hkipo-engine/0.1" },
    });
    if (!resp.ok) {
      console.error(`[discovery] Failed to fetch ${url}: ${resp.status}`);
      return "";
    }
    return await resp.text();
  } catch (err) {
    console.error(`[discovery] Error fetching ${url}:`, err);
    return "";
  }
}

/**
 * Parse the HKEXnews "New Listings" HTML page.
 *
 * The page contains an HTML table with columns:
 *   Stock Code | Stock Name | NEW LISTING ANNOUNCEMENTS | PROSPECTUSES | ALLOTMENT RESULTS
 *
 * Each row has the stock code and company name in the first two cells,
 * followed by cells that may contain one or more `<a href="...pdf">` links.
 *
 * We use regex-based extraction since we run in Cloudflare Workers
 * (no DOMParser available) and cannot add npm dependencies.
 */
function parseNewListingsHtml(
  html: string,
  board: "Main",
): NewListingEntry[] {
  if (!html) return [];

  const results: NewListingEntry[] = [];

  // The listings sit inside <tbody> ... </tbody> of the main table.
  // Extract the tbody content first.
  const tbodyMatch = findMainListingsTable(html);
  if (!tbodyMatch) return results;

  // Split into rows: each <tr>...</tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tbodyMatch)) !== null) {
    const rowHtml = rowMatch[1];

    // Extract all <td> cells
    const cells = extractCells(rowHtml);
    if (cells.length < 5) continue;

    // Cell 0: Stock Code (may be wrapped in spans/links)
    const stockCode = extractTextContent(cells[0]).trim();
    if (!stockCode || !/^\d{4,5}$/.test(stockCode)) continue;

    // Cell 1: Company Name
    const companyName = extractTextContent(cells[1]).trim();
    if (!companyName) continue;

    // Cell 3: PDF links for prospectuses
    const prospectusUrls = extractPdfUrls(cells[3]);

    results.push({
      stockCode,
      companyName,
      board,
      prospectusUrls,
    });
  }

  return results;
}

/**
 * Find the main listings table body in the HTML.
 *
 * The New Listings page may contain multiple tables (e.g. the NLR reports
 * table at the bottom).  The main listings table is the one that has column
 * headers containing "Stock Code" (EN) or "股份代號" (TC).
 */
function findMainListingsTable(html: string): string | null {
  // Look for a <table> that contains the stock-code header, then grab its <tbody>
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    // Check if this table has the stock code header
    if (
      /Stock\s*Code/i.test(tableHtml) ||
      /股份代號/i.test(tableHtml) ||
      /股份代号/i.test(tableHtml)
    ) {
      // Extract tbody
      const tbodyRegex = /<tbody[^>]*>[\s\S]*?<\/tbody>/i;
      const tbodyMatch = tbodyRegex.exec(tableHtml);
      if (tbodyMatch) return tbodyMatch[0];
      // No explicit tbody – use the whole table
      return tableHtml;
    }
  }

  // Fallback: if the page doesn't wrap rows in a <table>, try to find
  // the listing container div.  The www2 Sitecore pages sometimes load
  // table content via AJAX snippets that just have <tr> rows.
  return null;
}

/** Extract all <td>...</td> cell contents from a row HTML string. */
function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = cellRegex.exec(rowHtml)) !== null) {
    cells.push(m[1]);
  }
  return cells;
}

/** Strip HTML tags to get the plain text content of a cell. */
function extractTextContent(cellHtml: string): string {
  // Decode common HTML entities
  let text = cellHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2f;/gi, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/gi, "'");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Extract all PDF href URLs from a cell's HTML. */
function extractPdfUrls(cellHtml: string): string[] {
  const urls: string[] = [];
  const linkRegex = /href="([^"]*\.pdf)"/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(cellHtml)) !== null) {
    let url = m[1];
    // Make absolute if relative
    if (url.startsWith("/")) {
      url = "https://www1.hkexnews.hk" + url;
    }
    urls.push(url);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Merge EN/TC names and flatten into DiscoveredFiling[]
// ---------------------------------------------------------------------------

/**
 * Build a map of stock code -> { en, tc } company names by matching
 * English and Traditional Chinese page results by stock code.
 */
function buildCompanyNameMap(
  enEntries: NewListingEntry[],
  tcEntries: NewListingEntry[],
): Map<string, CompanyNamePair> {
  const map = new Map<string, CompanyNamePair>();

  for (const e of enEntries) {
    if (!map.has(e.stockCode)) {
      map.set(e.stockCode, { en: e.companyName, tc: "" });
    } else {
      map.get(e.stockCode)!.en = e.companyName;
    }
  }

  for (const e of tcEntries) {
    const existing = map.get(e.stockCode);
    if (existing) {
      existing.tc = e.companyName;
    } else {
      map.set(e.stockCode, { en: "", tc: e.companyName });
    }
  }

  return map;
}

/**
 * Convert NewListingEntry[] into flat DiscoveredFiling[],
 * enriched with TC names from the name map.
 */
function mergeNewListingsToFilings(
  entries: NewListingEntry[],
  names: Map<string, CompanyNamePair>,
  lang: "en" | "tc",
): DiscoveredFiling[] {
  const filings: DiscoveredFiling[] = [];

  for (const entry of entries) {
    const pair = names.get(entry.stockCode) ?? { en: entry.companyName, tc: "" };

    const makeFiling = (
      url: string,
      category: string,
      title: string,
    ): DiscoveredFiling => ({
      companyNameEn: pair.en,
      companyNameTc: pair.tc,
      stockCode: entry.stockCode,
      board: entry.board,
      lang,
      category,
      title,
      sourceUrl: url,
    });

    for (const url of entry.prospectusUrls) {
      filings.push(makeFiling(url, "Listing Document", "Prospectus"));
    }
  }

  return filings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a URL for de-duplication.
 * - Strip the `_c` suffix that differentiates Chinese PDF variants
 *   (EN: 2026031600013.pdf, TC: 2026031600014_c.pdf — these are different docs)
 * - Actually the _c versions are genuinely different documents (Chinese version),
 *   so we only normalise the protocol and trailing slashes.
 */
function normaliseUrl(url: string): string {
  return url
    .replace(/^https?:/, "https:")
    .replace(/\/+$/, "")
    .trim();
}
