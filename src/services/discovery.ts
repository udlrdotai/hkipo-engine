import type { Env } from "../models/types";

// ---------------------------------------------------------------------------
// URLs for the two HTML "New Listings" pages (www2 – Sitecore CMS)
// ---------------------------------------------------------------------------
const HKEX_NEW_LISTINGS_MAIN_EN =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=en";
const HKEX_NEW_LISTINGS_MAIN_TC =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=zh-HK";
const HKEX_NEW_LISTINGS_GEM_EN =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en";
const HKEX_NEW_LISTINGS_GEM_TC =
  "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=zh-HK";

// ---------------------------------------------------------------------------
// Title Search API (www1) – structured search endpoint
// ---------------------------------------------------------------------------
const TITLE_SEARCH_URL =
  "https://www1.hkexnews.hk/search/titlesearch.xhtml";

/**
 * Tier-1 and Tier-2 headline category codes used by the Title Search API.
 *
 * Reference: /ncms/script/eds/tierone_e.json, tiertwo_e.json
 *
 * Key IPO-related categories:
 *   t1=30000 "Listing Documents"
 *     t2=30600 "Offer for Sale"
 *     t2=30700 "Offer for Subscription"
 *     t2=31000 "Placing of Securities of a Class New to Listing"
 *     t2=30500 "Introduction"
 *   t1=10000 "Announcements and Notices"
 *     t2=15100 "Allotment Results"        (t2Gcode=5)
 *     t2=15200 "Formal Notice"            (t2Gcode=5)
 *     t2=15500 "Supplemental Info re IPO" (t2Gcode=5)
 *   t1=91000 "Application Proofs, OC Announcements and PHIPs"
 *     t2=91100 "Post Hearing Information Packs or PHIPs"
 *     t2=91200 "Application Proofs"
 */
interface TitleSearchQuery {
  /** "SEHK" (Main Board) or "GEM" */
  market: "SEHK" | "GEM";
  /** First-tier headline category code */
  t1code: number;
  /** Second-tier group code.  -2 = specific t2code selected; -1 = all */
  t2Gcode: number;
  /** Second-tier headline category code.  -1 = all under the t1 */
  t2code: number;
  /** Date range start YYYYMMDD */
  from: number;
  /** Date range end   YYYYMMDD */
  to: number;
}

// ---------------------------------------------------------------------------
// Public entry point – called by Cron Trigger
// ---------------------------------------------------------------------------

/**
 * Discover new IPO prospectuses from HKEXnews.
 * Called by Cron Trigger on schedule.
 *
 * Strategy: use two complementary data sources
 * 1. **New Listings HTML pages** – gives company full names (EN + TC),
 *    stock codes, and links to announcements/prospectuses/allotment results
 *    in a compact table.
 * 2. **Title Search API** – gives structured per-document results with
 *    release timestamps, stock short names, document titles, headline
 *    categories, and PDF links.  Covers broader filing types.
 *
 * Both are merged and de-duplicated by source_url before persisting.
 */
export async function discover(env: Env): Promise<void> {
  // ---- Source 1: New Listings HTML pages ----
  const [mainEn, mainTc, gemEn, gemTc] = await Promise.all([
    fetchHtml(HKEX_NEW_LISTINGS_MAIN_EN),
    fetchHtml(HKEX_NEW_LISTINGS_MAIN_TC),
    fetchHtml(HKEX_NEW_LISTINGS_GEM_EN),
    fetchHtml(HKEX_NEW_LISTINGS_GEM_TC),
  ]);

  const mainListingsEn = parseNewListingsHtml(mainEn, "Main");
  const mainListingsTc = parseNewListingsHtml(mainTc, "Main");
  const gemListingsEn = parseNewListingsHtml(gemEn, "GEM");
  const gemListingsTc = parseNewListingsHtml(gemTc, "GEM");

  // Merge English and TC names by stock code
  const companyNames = buildCompanyNameMap(
    [...mainListingsEn, ...gemListingsEn],
    [...mainListingsTc, ...gemListingsTc],
  );

  // Flatten HTML-sourced filings
  const htmlFilings = mergeNewListingsToFilings(
    [...mainListingsEn, ...gemListingsEn],
    companyNames,
  );

  // ---- Source 2: Title Search API ----
  const titleSearchFilings = await discoverViaTitleSearch();

  // ---- Merge & de-duplicate by source_url ----
  const seenUrls = new Set<string>();
  const allResults: DiscoveredFiling[] = [];

  // Title search results are richer (have release time, doc title) so add first
  for (const f of titleSearchFilings) {
    const normUrl = normaliseUrl(f.sourceUrl);
    if (!seenUrls.has(normUrl)) {
      seenUrls.add(normUrl);
      // Enrich with full company names from the HTML pages where possible
      const names = companyNames.get(f.stockCode);
      if (names) {
        if (!f.companyNameEn && names.en) f.companyNameEn = names.en;
        if (!f.companyNameTc && names.tc) f.companyNameTc = names.tc;
      }
      allResults.push(f);
    }
  }
  for (const f of htmlFilings) {
    const normUrl = normaliseUrl(f.sourceUrl);
    if (!seenUrls.has(normUrl)) {
      seenUrls.add(normUrl);
      allResults.push(f);
    }
  }

  // ---- Persist ----
  for (const item of allResults) {
    await persistFiling(env, item);
  }
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

  if (!company) {
    const nameEn = item.companyNameEn || item.stockShortNameEn || item.stockCode || "Unknown";
    const res = await env.DB.prepare(
      "INSERT INTO company (name_en, name_tc, stock_code) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(nameEn, item.companyNameTc || "", item.stockCode || null)
      .first<{ id: number }>();
    company = res!;
  } else {
    // Back-fill TC name / stock_code if we now have them
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
    "INSERT INTO filing (ipo_id, category, title, source_url) VALUES (?, ?, ?, ?)",
  )
    .bind(ipo.id, item.category, item.title, item.sourceUrl)
    .run();

  console.log(
    `[discovery] New filing: ${item.companyNameEn || item.stockCode} – ${item.title}`,
  );
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface DiscoveredFiling {
  companyNameEn: string;
  companyNameTc: string;
  stockCode: string;
  stockShortNameEn: string;
  board: "Main" | "GEM";
  category: string;
  title: string;
  sourceUrl: string;
  releaseTime: string;
}

/** One row from the "New Listings" HTML table (per stock) */
interface NewListingEntry {
  stockCode: string;
  companyName: string;
  board: "Main" | "GEM";
  announcementUrls: string[];
  prospectusUrls: string[];
  allotmentUrls: string[];
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
  board: "Main" | "GEM",
): NewListingEntry[] {
  if (!html) return [];

  const results: NewListingEntry[] = [];

  // The listings sit inside <tbody> ... </tbody> of the main table.
  // Extract the tbody content first.
  const tbodyMatch = findMainListingsTable(html);
  if (!tbodyMatch) return results;

  // Split into rows: each <tr>...</tr>
  const rowRegex = /<tr[\s>]([\s\S]*?)<\/tr>/gi;
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

    // Cells 2-4: PDF links for announcements, prospectuses, allotment results
    const announcementUrls = extractPdfUrls(cells[2]);
    const prospectusUrls = extractPdfUrls(cells[3]);
    const allotmentUrls = extractPdfUrls(cells[4]);

    results.push({
      stockCode,
      companyName,
      board,
      announcementUrls,
      prospectusUrls,
      allotmentUrls,
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
      const tbodyRegex = /<tbody[\s>][\s\S]*?<\/tbody>/i;
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
  const cellRegex = /<td[\s>]([\s\S]*?)<\/td>/gi;
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
      stockShortNameEn: "",
      board: entry.board,
      category,
      title,
      sourceUrl: url,
      releaseTime: "",
    });

    for (const url of entry.announcementUrls) {
      filings.push(makeFiling(url, "New Listing Announcement", "New Listing Announcement"));
    }
    for (const url of entry.prospectusUrls) {
      filings.push(makeFiling(url, "Listing Document", "Prospectus"));
    }
    for (const url of entry.allotmentUrls) {
      filings.push(makeFiling(url, "Allotment Results", "Allotment Results"));
    }
  }

  return filings;
}

// ---------------------------------------------------------------------------
// Source 2: Title Search API
// ---------------------------------------------------------------------------

/**
 * Discover filings via the HKEXnews Title Search API.
 *
 * POST https://www1.hkexnews.hk/search/titlesearch.xhtml
 *
 * The API returns server-rendered HTML (not JSON).  Each result row contains:
 *   - Release time        (td.release-time)
 *   - Stock code          (td.stock-short-code)
 *   - Stock short name    (td.stock-short-name)
 *   - Document details    (div.headline + div.doc-link with <a> to PDF)
 *
 * We query multiple IPO-relevant category combinations and merge results.
 */
async function discoverViaTitleSearch(): Promise<DiscoveredFiling[]> {
  const { from, to } = getSearchDateRange();

  // Define the category queries we care about
  const queries: Array<TitleSearchQuery & { board: "Main" | "GEM" }> = [];

  for (const market of ["SEHK", "GEM"] as const) {
    const board: "Main" | "GEM" = market === "SEHK" ? "Main" : "GEM";

    // Listing Documents – Offer for Subscription (IPO prospectuses)
    queries.push({ market, t1code: 30000, t2Gcode: -2, t2code: 30700, from, to, board });
    // Listing Documents – Offer for Sale
    queries.push({ market, t1code: 30000, t2Gcode: -2, t2code: 30600, from, to, board });
    // Listing Documents – Introduction
    queries.push({ market, t1code: 30000, t2Gcode: -2, t2code: 30500, from, to, board });
    // Listing Documents – Placing of Securities of a Class New to Listing
    queries.push({ market, t1code: 30000, t2Gcode: -2, t2code: 31000, from, to, board });
    // Announcements – Allotment Results
    queries.push({ market, t1code: 10000, t2Gcode: -2, t2code: 15100, from, to, board });
    // Announcements – Formal Notice
    queries.push({ market, t1code: 10000, t2Gcode: -2, t2code: 15200, from, to, board });
    // Application Proofs / PHIPs (pre-IPO filings)
    queries.push({ market, t1code: 91000, t2Gcode: -1, t2code: -1, from, to, board });
  }

  // Execute all queries in parallel
  const batchResults = await Promise.all(
    queries.map(async (q) => {
      try {
        const html = await postTitleSearch(q);
        return parseTitleSearchHtml(html, q.board);
      } catch (err) {
        console.error(
          `[discovery] Title search error (t1=${q.t1code}, t2=${q.t2code}, market=${q.market}):`,
          err,
        );
        return [] as DiscoveredFiling[];
      }
    }),
  );

  // Flatten and de-dup by sourceUrl
  const seen = new Set<string>();
  const results: DiscoveredFiling[] = [];
  for (const batch of batchResults) {
    for (const f of batch) {
      const normUrl = normaliseUrl(f.sourceUrl);
      if (!seen.has(normUrl)) {
        seen.add(normUrl);
        results.push(f);
      }
    }
  }

  return results;
}

/**
 * POST to the Title Search API and return the HTML response body.
 */
async function postTitleSearch(q: TitleSearchQuery): Promise<string> {
  const body = new URLSearchParams({
    lang: "EN",
    market: q.market,
    searchType: "1",
    t1code: String(q.t1code),
    t2Gcode: String(q.t2Gcode),
    t2code: String(q.t2code),
    stockId: "-1",
    from: String(q.from),
    to: String(q.to),
    category: "0",
  });

  const resp = await fetch(TITLE_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "hkipo-engine/0.1",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Title search HTTP ${resp.status}`);
  }

  return resp.text();
}

/**
 * Parse the Title Search API HTML response into DiscoveredFiling[].
 *
 * Each result row has this structure:
 * ```html
 * <tr>
 *   <td class="... release-time">
 *     <span class="mobile-list-heading">Release Time: </span>16/03/2026 06:16
 *   </td>
 *   <td class="... stock-short-code">
 *     <span class="mobile-list-heading">Stock Code: </span>02729
 *   </td>
 *   <td class="stock-short-name">
 *     <span class="mobile-list-heading">Stock Short Name: </span>GALAXIS TECH
 *   </td>
 *   <td>
 *     <div class="headline">Listing Documents - [Offer for Subscription]</div>
 *     <div class="doc-link">
 *       <a href="/listedco/listconews/sehk/2026/0316/2026031600013.pdf" ...>
 *         GLOBAL OFFERING
 *       </a>
 *       (<span class="attachment_filesize">9MB</span>)
 *     </div>
 *   </td>
 * </tr>
 * ```
 */
function parseTitleSearchHtml(
  html: string,
  board: "Main" | "GEM",
): DiscoveredFiling[] {
  if (!html) return [];

  const results: DiscoveredFiling[] = [];

  // Extract <tbody>...</tbody>
  const tbodyRegex = /<tbody[\s>]([\s\S]*?)<\/tbody>/i;
  const tbodyMatch = tbodyRegex.exec(html);
  if (!tbodyMatch) return results;

  const tbody = tbodyMatch[1];

  // Split into <tr>...</tr> rows
  const rowRegex = /<tr[\s>]([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tbody)) !== null) {
    const row = rowMatch[1];

    // Release time: text after the mobile-list-heading span in td.release-time
    const releaseTime = extractFieldAfterHeading(row, "release-time") || "";

    // Stock code: text in td.stock-short-code
    const rawStockCode = extractFieldAfterHeading(row, "stock-short-code") || "";
    const stockCode = rawStockCode.replace(/^0+/, "") || rawStockCode; // strip leading zeros: "02729" -> "2729"

    // Stock short name: text in td.stock-short-name
    const stockShortName = extractFieldAfterHeading(row, "stock-short-name") || "";

    // Headline category: text inside div.headline
    const headlineMatch = /<div\s+class="headline">([\s\S]*?)<\/div>/i.exec(row);
    const headline = headlineMatch
      ? extractTextContent(headlineMatch[1]).trim()
      : "";

    // Map headline to a category string
    const category = mapHeadlineToCategory(headline);

    // Document links: <div class="doc-link"><a href="...">title</a>...</div>
    // There may be multiple doc-link divs per row
    const docLinkRegex =
      /<div\s+class="doc-link">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let docMatch: RegExpExecArray | null;

    while ((docMatch = docLinkRegex.exec(row)) !== null) {
      let url = docMatch[1].trim();
      if (url.startsWith("/")) {
        url = "https://www1.hkexnews.hk" + url;
      }
      const docTitle = extractTextContent(docMatch[2]).trim() || headline;

      results.push({
        companyNameEn: "",
        companyNameTc: "",
        stockCode,
        stockShortNameEn: stockShortName,
        board,
        category,
        title: docTitle,
        sourceUrl: url,
        releaseTime,
      });
    }
  }

  return results;
}

/**
 * Extract the text content that follows a `<span class="mobile-list-heading">`
 * inside a `<td>` whose class list contains the given className.
 *
 * Example: for className="stock-short-code" in
 *   `<td class="text-right text-end stock-short-code"><span ...>Stock Code: </span>02729</td>`
 * returns "02729".
 */
function extractFieldAfterHeading(
  rowHtml: string,
  className: string,
): string | null {
  // Build a regex that finds a <td> with the given class, then captures
  // the text after the closing </span> of the mobile-list-heading.
  const pattern = new RegExp(
    `<td[^>]*\\b${className}\\b[^>]*>[\\s\\S]*?<\\/span>([\\s\\S]*?)<\\/td>`,
    "i",
  );
  const m = pattern.exec(rowHtml);
  if (!m) return null;
  return extractTextContent(m[1]).trim();
}

/** Map a headline string from the Title Search to a filing category. */
function mapHeadlineToCategory(headline: string): string {
  const h = headline.toLowerCase();
  if (h.includes("listing documents")) {
    if (h.includes("offer for subscription")) return "Listing Document - Offer for Subscription";
    if (h.includes("offer for sale")) return "Listing Document - Offer for Sale";
    if (h.includes("introduction")) return "Listing Document - Introduction";
    if (h.includes("placing")) return "Listing Document - Placing";
    return "Listing Document";
  }
  if (h.includes("allotment results")) return "Allotment Results";
  if (h.includes("formal notice")) return "Formal Notice";
  if (h.includes("application proofs")) return "Application Proof";
  if (h.includes("post hearing") || h.includes("phip")) return "PHIP";
  if (h.includes("oc announcement")) return "OC Announcement";
  if (h.includes("supplemental") && h.includes("ipo")) return "Supplemental IPO Info";
  // Fallback: use the headline as-is
  return headline || "Other";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a search date range for the Title Search API.
 * With a headline category selected (but no stock code), max range is 12 months.
 * We use a rolling 1-month window ending today to stay conservative.
 */
function getSearchDateRange(): { from: number; to: number } {
  const now = new Date();
  const to =
    now.getFullYear() * 10000 +
    (now.getMonth() + 1) * 100 +
    now.getDate();

  // 1 month back
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const from =
    oneMonthAgo.getFullYear() * 10000 +
    (oneMonthAgo.getMonth() + 1) * 100 +
    oneMonthAgo.getDate();

  return { from, to };
}

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
