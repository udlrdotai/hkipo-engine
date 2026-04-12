import { Hono } from "hono";
import type { Env } from "../models/types";

export const webRoutes = new Hono<{ Bindings: Env }>();

// ─────────────────────────── token (HMAC, 5 min TTL) ───────────────────────────

const TOKEN_TTL_SECONDS = 300;

function getSecret(env: Env): string {
  return env.WEB_TOKEN_SECRET || env.ADMIN_API_KEY || "dev-fallback-secret";
}

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return atob(b64);
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(sig);
}

async function makeToken(stockCode: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${stockCode}:${exp}`;
  const sig = await hmac(payload, secret);
  return `${b64url(payload)}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = b64urlDecode(parts[0]);
  } catch {
    return null;
  }
  const expected = await hmac(payload, secret);
  // constant-time-ish compare
  if (expected.length !== parts[1].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (diff !== 0) return null;
  const [stockCode, expStr] = payload.split(":");
  if (!stockCode || !expStr) return null;
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return null;
  return stockCode;
}

// ─────────────────────────── helpers ───────────────────────────

function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJSON<T = unknown>(s: unknown): T | null {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function fmtPriceBand(low: number | null, high: number | null, currency: string | null): string {
  if (low == null || high == null) return "—";
  const cur = currency || "HK$";
  return `${cur === "HKD" ? "HK$" : cur}${low.toFixed(2)}–${high.toFixed(2)}`;
}

function deriveStatus(listingDate: string | null): "offering" | "listed" | "—" {
  if (!listingDate) return "—";
  const d = new Date(listingDate).getTime();
  if (isNaN(d)) return "—";
  return d < Date.now() ? "listed" : "offering";
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

// ─────────────────────────── shared CSS / shell ───────────────────────────

const CSS = `
  :root {
    --bg:#fafaf8; --bg-2:#f3f2ee; --ink:#18181b; --ink-2:#3f3f46;
    --mute:#8a8a8f; --line:#e7e5df; --line-2:#d6d3cb;
    --accent:#c2410c; --good:#15803d; --bad:#b91c1c;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--ink)}
  body{font-family:"Inter Tight",-apple-system,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;font-feature-settings:"ss01","cv11"}
  a{color:inherit;text-decoration:none}
  .serif{font-family:"Instrument Serif",Georgia,serif;font-weight:400}
  .mono{font-family:"JetBrains Mono",monospace;font-variant-numeric:tabular-nums}
  .wrap{max-width:1180px;margin:0 auto;padding:0 40px}
  header.site{padding:28px 0 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
  header.site .brand{font-family:"Instrument Serif",serif;font-size:22px;letter-spacing:-0.01em}
  header.site .brand em{font-style:italic;color:var(--accent)}
  header.site nav{display:flex;gap:28px;font-size:13px;color:var(--ink-2)}
  header.site nav a:hover{color:var(--accent)}
  header.site nav a.active{color:var(--ink)}
  footer.site{margin-top:80px;padding:32px 0 60px;border-top:1px solid var(--line);display:flex;justify-content:space-between;font-size:12px;color:var(--mute)}
  @keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .fade>*{opacity:0;animation:fade .6s ease forwards}
  .fade>*:nth-child(1){animation-delay:.05s}
  .fade>*:nth-child(2){animation-delay:.12s}
  .fade>*:nth-child(3){animation-delay:.20s}
  .fade>*:nth-child(4){animation-delay:.28s}
  .fade>*:nth-child(5){animation-delay:.36s}
  .fade>*:nth-child(6){animation-delay:.44s}
`;

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
`;

type NavKey = "filings" | "calendar" | "";

function shell(title: string, body: string, extraCSS = "", active: NavKey = "filings"): string {
  const navCls = (key: NavKey) => (active === key ? ' class="active"' : "");
  return `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
${FONTS}
<style>${CSS}${extraCSS}</style>
</head><body>
<div class="wrap">
<header class="site">
  <a href="/" class="brand">HKIPO<em>Radar</em></a>
  <nav>
    <a href="/"${navCls("filings")}>Filings</a>
    <a href="/calendar"${navCls("calendar")}>Calendar</a>
    <a href="#">Sponsors</a>
    <a href="#">API</a>
  </nav>
</header>
${body}
<footer class="site">
  <div>© HKIPORadar · Compiled from HKEXnews · Not investment advice</div>
  <div>v0.1</div>
</footer>
</div>
</body></html>`;
}

// ─────────────────────────── list page ───────────────────────────

const LIST_CSS = `
  .hero{padding:72px 0 44px}
  .hero .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-bottom:18px}
  .hero .eyebrow .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:8px;vertical-align:middle}
  .hero h1{font-family:"Instrument Serif",serif;font-weight:400;font-size:clamp(44px,6vw,76px);line-height:1.05;letter-spacing:-.025em;margin:0 0 20px;max-width:18ch}
  .hero h1 em{font-style:italic;color:var(--accent)}
  .hero p{font-size:17px;color:var(--ink-2);max-width:56ch;margin:0}
  .toolbar{display:flex;align-items:center;justify-content:flex-end;gap:20px;padding:22px 0 14px;border-bottom:1px solid var(--line)}
  .search{display:flex;align-items:center;gap:10px;border:1px solid var(--line-2);background:var(--bg);padding:9px 14px;border-radius:999px;width:320px}
  .search:focus-within{border-color:var(--ink)}
  .search svg{flex-shrink:0;opacity:.5}
  .search input{border:0;outline:0;background:transparent;font:inherit;font-size:13px;width:100%;color:var(--ink)}
  .search input::placeholder{color:var(--mute)}
  table.list{width:100%;border-collapse:collapse;margin-top:4px}
  table.list thead th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);padding:16px;border-bottom:1px solid var(--line)}
  table.list thead th.num{text-align:right}
  table.list tbody tr{cursor:pointer;transition:background .12s ease;border-bottom:1px solid var(--line)}
  table.list tbody tr:hover{background:var(--bg-2)}
  table.list tbody td{padding:22px 16px;vertical-align:middle}
  table.list tbody td.num{text-align:right;font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--ink-2)}
  .code{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute);letter-spacing:.02em}
  .co{font-size:16px;font-weight:500;letter-spacing:-0.01em;color:var(--ink);margin-bottom:2px}
  .co-sub{font-size:12px;color:var(--mute)}
  .industry,.sponsor{font-size:13px;color:var(--ink-2)}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 10px;border-radius:999px;font-weight:500;letter-spacing:.02em}
  .pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
  .pill.offering{color:var(--accent);background:rgba(194,65,12,.08)}
  .pill.listed{color:var(--good);background:rgba(21,128,61,.08)}
  .pill.dash{color:var(--mute);background:rgba(138,138,143,.1)}
  .arrow{display:inline-block;color:var(--mute);transition:all .2s ease;font-family:"Instrument Serif",serif;font-size:22px}
  tr:hover .arrow{color:var(--accent);transform:translateX(4px)}
  .empty{padding:80px 0;text-align:center;color:var(--mute);font-size:14px}
  @media(max-width:820px){
    .wrap{padding:0 20px}
    .toolbar{flex-direction:column;align-items:stretch}.search{width:100%}
    table.list thead{display:none}
    table.list tbody tr{display:block;padding:18px 0}
    table.list tbody td{display:block;padding:4px 0;text-align:left!important}
  }
`;

interface ListRow {
  stock_code: string;
  company_name: string | null;
  company_name_tc: string | null;
  industry: string | null;
  listing_date: string | null;
  price_low: number | null;
  price_high: number | null;
  currency: string | null;
}

webRoutes.get("/", async (c) => {
  // Prefer English row; fall back to TC if no English variant exists.
  // Also pull TC company_name as a sub-label when available.
  const rows = await c.env.DB.prepare(
    `
    SELECT
      p.stock_code,
      p.company_name,
      NULL AS company_name_tc,
      p.industry,
      p.listing_date,
      p.price_low,
      p.price_high,
      p.currency
    FROM prospectus p
    WHERE p.status = 'parsed' AND p.lang = 'tc'
    ORDER BY COALESCE(p.listing_date, p.updated_at) DESC
    `,
  ).all<ListRow>();

  const secret = getSecret(c.env);
  const list = rows.results || [];

  // Pre-sign all detail tokens server-side (5-min TTL).
  const tokens = await Promise.all(list.map((r) => makeToken(r.stock_code, secret)));

  const rowsHtml = list.length
    ? list
        .map((r, i) => {
          const status = deriveStatus(r.listing_date);
          const pillClass = status === "offering" ? "offering" : status === "listed" ? "listed" : "dash";
          const tcSub = r.company_name_tc && r.company_name_tc !== r.company_name ? r.company_name_tc : "";
          return `
        <tr onclick="location.href='/co/${esc(tokens[i])}'">
          <td><span class="code">${esc(r.stock_code)}.HK</span></td>
          <td>
            <div class="co">${esc(r.company_name || "—")}</div>
            ${tcSub ? `<div class="co-sub">${esc(tcSub)}</div>` : ""}
          </td>
          <td><span class="industry">${esc(r.industry || "—")}</span></td>
          <td class="num">${fmtDate(r.listing_date)}</td>
          <td class="num">${esc(fmtPriceBand(r.price_low, r.price_high, r.currency))}</td>
          <td><span class="pill ${pillClass}">${status}</span></td>
          <td class="num"><span class="arrow">→</span></td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="7"><div class="empty">No filings available yet.</div></td></tr>`;

  const body = `
<section>
  <div class="hero">
    <div class="eyebrow"><span class="dot"></span>HONG KONG MAIN BOARD</div>
    <h1>Every prospectus, <em>structured.</em></h1>
    <p>A simple ledger of Hong Kong Main Board IPO filings — AI-extracted from HKEXnews prospectuses and laid out for quick review. Free to read for humans. Always do your own research.</p>
  </div>
  <div class="toolbar">
    <div class="search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="q" placeholder="Search code, company, industry…" autocomplete="off">
    </div>
  </div>
  <table class="list">
    <thead><tr>
      <th style="width:80px">Code</th>
      <th>Company</th>
      <th>Industry</th>
      <th class="num" style="width:120px">Listing date</th>
      <th class="num" style="width:140px">Price band</th>
      <th style="width:110px">Status</th>
      <th class="num" style="width:60px"></th>
    </tr></thead>
    <tbody id="rows">${rowsHtml}</tbody>
  </table>
</section>
<script>
  // Client-side filter only — no API calls, all data already in DOM.
  const q = document.getElementById('q');
  const rows = Array.from(document.querySelectorAll('#rows tr'));
  q && q.addEventListener('input', () => {
    const v = q.value.toLowerCase().trim();
    rows.forEach(r => {
      r.style.display = !v || r.textContent.toLowerCase().includes(v) ? '' : 'none';
    });
  });
</script>
`;
  return c.html(shell("HKIPO — Hong Kong Main Board Filings", body, LIST_CSS));
});

// ─────────────────────────── detail page ───────────────────────────

const DETAIL_CSS = `
  .back{background:none;border:0;font:inherit;font-size:13px;color:var(--mute);cursor:pointer;padding:0;display:inline-flex;align-items:center;gap:8px;margin-top:32px}
  .back:hover{color:var(--accent)}
  .detail-head{padding:32px 0 40px;border-bottom:1px solid var(--line)}
  .detail-head .code{font-size:13px;color:var(--accent);margin-bottom:14px;letter-spacing:.04em}
  .detail-head h2{font-family:"Instrument Serif",serif;font-weight:400;font-size:clamp(40px,5.5vw,68px);line-height:1.05;letter-spacing:-.025em;margin:0 0 8px}
  .detail-head h2 em{font-style:italic;color:var(--accent)}
  .detail-head .tc{font-size:17px;color:var(--mute);font-style:italic}
  .detail-head .tagline{margin-top:22px;font-size:17px;color:var(--ink-2);max-width:62ch;line-height:1.55}
  .detail-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:70px;padding:50px 0}
  .section{margin-bottom:48px}
  .section h3{font-family:"Inter Tight",sans-serif;font-weight:500;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin:0 0 18px;padding-bottom:12px;border-bottom:1px solid var(--line)}
  .fin-table{width:100%;border-collapse:collapse}
  .fin-table th,.fin-table td{padding:13px 4px;font-size:14px}
  .fin-table th{text-align:left;font-weight:500;color:var(--mute);border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .fin-table th.num,.fin-table td.num{text-align:right}
  .fin-table td{border-bottom:1px solid var(--line);font-family:"JetBrains Mono",monospace;color:var(--ink-2)}
  .fin-table td.lab{font-family:"Inter Tight",sans-serif;color:var(--ink)}
  .uop-list{list-style:none;padding:0;margin:0}
  .uop-list li{padding:16px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:64px 1fr auto;gap:16px;align-items:baseline}
  .uop-list .pct{font-family:"Instrument Serif",serif;font-size:26px;color:var(--accent)}
  .uop-list .lab{font-size:14px}
  .uop-list .amt{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute);white-space:nowrap}
  .corner-list,.risks{padding:0;margin:0;list-style:none}
  .corner-list li{padding:14px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;font-size:14px;gap:14px}
  .corner-list .amt{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute);white-space:nowrap}
  .corner-list .bg{font-size:11px;color:var(--mute);margin-top:2px}
  .risks{counter-reset:r}
  .risks li{padding:12px 0;border-bottom:1px solid var(--line);font-size:14px;color:var(--ink-2);display:grid;grid-template-columns:32px 1fr;gap:8px}
  .risks li::before{counter-increment:r;content:counter(r,decimal-leading-zero);font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--accent)}
  .terms-card{background:var(--bg-2);border-radius:12px;padding:24px;margin-bottom:24px}
  .terms-card h4{margin:0 0 16px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);font-weight:500}
  .terms-card .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-2);font-size:13px;gap:12px}
  .terms-card .row:last-child{border-bottom:0}
  .terms-card .row .k{color:var(--mute)}
  .terms-card .row .v{color:var(--ink);font-weight:500;text-align:right}
  .terms-card .row .v.mono{font-family:"JetBrains Mono",monospace;font-weight:400}
  .empty-section{font-size:13px;color:var(--mute);font-style:italic}
  @media(max-width:820px){.wrap{padding:0 20px}.detail-grid{grid-template-columns:1fr;gap:30px}}
`;

interface ProspectusRow {
  stock_code: string;
  lang: string;
  company_name: string | null;
  industry: string | null;
  board: string | null;
  listing_date: string | null;
  offer_start: string | null;
  offer_end: string | null;
  price_low: number | null;
  price_high: number | null;
  currency: string | null;
  net_proceeds: number | null;
  business_summary: string | null;
  sponsors: string | null;
  financials: string | null;
  use_of_proceeds: string | null;
  cornerstone_investors: string | null;
  risk_factors: string | null;
}

interface IncomeRow {
  period?: string;
  end_date?: string;
  revenue?: number;
  gross_profit?: number;
  net_profit?: number;
  [k: string]: unknown;
}

interface FinancialsJSON {
  currency?: string;
  unit?: string;
  income_statement?: IncomeRow[];
  [k: string]: unknown;
}

interface UseOfProceedsItem {
  purpose?: string;
  percentage?: number;
  amount_hkd_million?: number;
  amount?: number;
  currency?: string;
}

interface CornerstoneItem {
  name?: string;
  background?: string;
  amount?: number;
  currency?: string;
  unit?: string;
}

interface SponsorsJSON {
  sponsors?: Array<{ name?: string }>;
  joint_sponsors?: Array<{ name?: string }>;
  [k: string]: unknown;
}

function fmtNum(n: number | undefined | null): string {
  if (n == null || isNaN(n as number)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US");
  return String(n);
}

function renderFinancials(fin: FinancialsJSON | null): string {
  if (!fin || !Array.isArray(fin.income_statement) || fin.income_statement.length === 0) {
    return `<div class="empty-section">Not available.</div>`;
  }
  const periods = fin.income_statement;
  const unit = fin.unit || "";
  const cur = fin.currency || "";
  const headers = periods
    .map((p) => `<th class="num">${esc(p.period || p.end_date || "—")}</th>`)
    .join("");
  const metrics: Array<[string, keyof IncomeRow]> = [
    ["Revenue", "revenue"],
    ["Gross profit", "gross_profit"],
    ["Net profit", "net_profit"],
  ];
  const rows = metrics
    .map(([label, key]) => {
      const cells = periods
        .map((p) => `<td class="num">${fmtNum(p[key] as number | undefined)}</td>`)
        .join("");
      return `<tr><td class="lab">${esc(label)}</td>${cells}</tr>`;
    })
    .join("");
  return `
    <table class="fin-table">
      <thead><tr><th>${esc(`${cur} ${unit}`.trim() || "Metric")}</th>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderUOP(uop: UseOfProceedsItem[] | null): string {
  if (!uop || uop.length === 0) return `<div class="empty-section">Not available.</div>`;
  return `<ul class="uop-list">${uop
    .map((u) => {
      const pct = u.percentage != null ? `${u.percentage}%` : "—";
      const amt =
        u.amount_hkd_million != null
          ? `HK$${u.amount_hkd_million.toLocaleString("en-US")}M`
          : u.amount != null
            ? `${u.currency || ""}${u.amount}`
            : "";
      return `<li><span class="pct">${esc(pct)}</span><span class="lab">${esc(u.purpose || "—")}</span><span class="amt">${esc(amt)}</span></li>`;
    })
    .join("")}</ul>`;
}

function renderCornerstones(items: CornerstoneItem[] | null): string {
  if (!items || items.length === 0) return `<div class="empty-section">Not available.</div>`;
  return `<ul class="corner-list">${items
    .map((c) => {
      const amt =
        c.amount != null ? `${c.currency || ""}${c.amount}${c.unit ? " " + c.unit : ""}` : "";
      return `<li>
        <div>
          <div>${esc(c.name || "—")}</div>
          ${c.background ? `<div class="bg">${esc(c.background)}</div>` : ""}
        </div>
        <span class="amt">${esc(amt)}</span>
      </li>`;
    })
    .join("")}</ul>`;
}

function renderRisks(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0)
    return `<div class="empty-section">Not available.</div>`;
  return `<ul class="risks">${items
    .map((r) => {
      const text = typeof r === "string" ? r : ((r as { title?: string; description?: string }).title || (r as { description?: string }).description || JSON.stringify(r));
      return `<li>${esc(text)}</li>`;
    })
    .join("")}</ul>`;
}

function renderSponsors(sp: SponsorsJSON | null): string {
  if (!sp) return "—";
  const list = [...(sp.sponsors || []), ...(sp.joint_sponsors || [])];
  if (list.length === 0) return "—";
  return list.map((s) => esc(s.name || "")).filter(Boolean).join(" · ");
}

webRoutes.get("/co/:token", async (c) => {
  const token = c.req.param("token");
  const secret = getSecret(c.env);
  const stockCode = await verifyToken(token, secret);

  if (!stockCode) {
    return c.html(
      shell(
        "Link expired — HKIPORadar",
        `<div style="padding:120px 0;text-align:center">
          <h1 class="serif" style="font-size:48px;margin:0 0 12px">Link expired.</h1>
          <p style="color:var(--mute);margin:0 0 24px">Detail links are valid for 5 minutes. Please return to the ledger.</p>
          <a href="/" style="color:var(--accent);font-size:14px">← Back to filings</a>
        </div>`,
      ),
      403,
    );
  }

  // Prefer English row; fall back to TC.
  const row = await c.env.DB.prepare(
    `SELECT * FROM prospectus
     WHERE stock_code = ? AND status = 'parsed'
     ORDER BY CASE lang WHEN 'en' THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(stockCode)
    .first<ProspectusRow>();

  if (!row) {
    return c.html(
      shell(
        "Not found — HKIPORadar",
        `<div style="padding:120px 0;text-align:center">
          <h1 class="serif" style="font-size:48px;margin:0">Not found.</h1>
          <a href="/" style="color:var(--accent);font-size:14px">← Back to filings</a>
        </div>`,
      ),
      404,
    );
  }

  const fin = safeJSON<FinancialsJSON>(row.financials);
  const uop = safeJSON<UseOfProceedsItem[]>(row.use_of_proceeds);
  const corn = safeJSON<CornerstoneItem[]>(row.cornerstone_investors);
  const risks = safeJSON<unknown>(row.risk_factors);
  const sponsors = safeJSON<SponsorsJSON>(row.sponsors);

  const name = row.company_name || row.stock_code;
  const parts = name.split(" ");
  const last = parts.length > 1 ? parts.pop() : "";
  const first = parts.join(" ");
  const status = deriveStatus(row.listing_date);

  const body = `
<section class="detail">
  <a class="back" href="/">← Back to filings</a>
  <div class="detail-head fade">
    <div class="code">${esc(row.stock_code)}.HK · ${esc(row.industry || "—")}</div>
    <h2>${esc(first)} ${last ? `<em>${esc(last)}.</em>` : ""}</h2>
    ${row.business_summary ? `<p class="tagline">${esc(row.business_summary)}</p>` : ""}
  </div>

  <div class="detail-grid fade">
    <div>
      <div class="section">
        <h3>Financials</h3>
        ${renderFinancials(fin)}
      </div>

      <div class="section">
        <h3>Use of proceeds</h3>
        ${renderUOP(uop)}
      </div>

      <div class="section">
        <h3>Risk factors</h3>
        ${renderRisks(risks)}
      </div>
    </div>

    <aside>
      <div class="terms-card">
        <h4>Offering terms</h4>
        <div class="row"><span class="k">Code</span><span class="v mono">${esc(row.stock_code)}.HK</span></div>
        <div class="row"><span class="k">Board</span><span class="v">${esc(row.board || "Main")}</span></div>
        <div class="row"><span class="k">Status</span><span class="v">${status}</span></div>
        <div class="row"><span class="k">Price band</span><span class="v mono">${esc(fmtPriceBand(row.price_low, row.price_high, row.currency))}</span></div>
        <div class="row"><span class="k">Net proceeds</span><span class="v mono">${row.net_proceeds != null ? esc((row.currency || "HK$") + row.net_proceeds.toLocaleString("en-US")) : "—"}</span></div>
        <div class="row"><span class="k">Offer period</span><span class="v mono">${esc(fmtDate(row.offer_start))} → ${esc(fmtDate(row.offer_end))}</span></div>
        <div class="row"><span class="k">Listing date</span><span class="v mono">${esc(fmtDate(row.listing_date))}</span></div>
        <div class="row"><span class="k">Sponsor(s)</span><span class="v">${renderSponsors(sponsors)}</span></div>
      </div>

      <div class="section">
        <h3>Cornerstone investors</h3>
        ${renderCornerstones(corn)}
      </div>
    </aside>
  </div>
</section>
`;
  return c.html(shell(`${name} — HKIPORadar`, body, DETAIL_CSS));
});

// ─────────────────────────── calendar page ───────────────────────────

const CAL_CSS = `
  .cal-head{padding:60px 0 28px}
  .cal-head .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-bottom:18px}
  .cal-head .eyebrow .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:8px;vertical-align:middle}
  .cal-head h1{font-family:"Instrument Serif",serif;font-weight:400;font-size:clamp(40px,5.5vw,68px);line-height:1.05;letter-spacing:-.025em;margin:0 0 16px;max-width:18ch}
  .cal-head h1 em{font-style:italic;color:var(--accent)}
  .cal-head p{font-size:16px;color:var(--ink-2);max-width:60ch;margin:0}
  .cal-bar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 0 18px;border-bottom:1px solid var(--line)}
  .cal-nav{display:flex;align-items:center;gap:12px}
  .cal-nav .arrow{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line-2);border-radius:999px;color:var(--ink-2);background:transparent;cursor:pointer;font:inherit;text-decoration:none;transition:all .15s ease}
  .cal-nav .arrow:hover{border-color:var(--ink);color:var(--ink)}
  .cal-nav .arrow[aria-disabled="true"]{opacity:.3;pointer-events:none}
  .cal-nav .month-pick{position:relative;display:inline-flex;align-items:center}
  .cal-nav .month-pick label{font-family:"Instrument Serif",serif;font-size:28px;letter-spacing:-.01em;color:var(--ink);cursor:pointer;padding:0 4px}
  .cal-nav .month-pick label:hover{color:var(--accent)}
  .cal-nav .month-pick input{position:absolute;inset:0;opacity:0;cursor:pointer;font:inherit;border:0;padding:0;color-scheme:light}
  .cal-nav .today-btn{font:inherit;font-size:12px;color:var(--mute);background:none;border:0;cursor:pointer;padding:6px 10px;letter-spacing:.04em;text-transform:uppercase;text-decoration:none}
  .cal-nav .today-btn:hover{color:var(--accent)}
  .cal-legend{display:flex;gap:18px;font-size:12px;color:var(--mute)}
  .cal-legend .lg{display:inline-flex;align-items:center;gap:6px}
  .cal-legend .lg::before{content:"";width:8px;height:8px;border-radius:2px;background:currentColor}
  .lg.start{color:var(--accent)}
  .lg.end{color:#a16207}
  .lg.list{color:var(--good)}
  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);border-left:1px solid var(--line);border-top:1px solid var(--line);margin-top:22px}
  .cal-dow{padding:10px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bg-2)}
  .cal-cell{min-height:120px;padding:10px 10px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bg);display:flex;flex-direction:column;gap:5px;overflow:hidden}
  .cal-cell.empty{background:var(--bg-2)}
  .cal-cell .num{font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums;margin-bottom:2px}
  .cal-cell.weekend .num{color:var(--mute)}
  .cal-cell.today{background:rgba(194,65,12,.04)}
  .cal-cell.today .num{color:var(--accent);font-weight:600}
  .cal-cell .ev{font-size:11px;line-height:1.3;padding:4px 7px;border-radius:4px;display:flex;flex-direction:column;gap:1px;border-left:2px solid currentColor;background:var(--bg-2);transition:background .12s ease;overflow:hidden}
  .cal-cell .ev:hover{background:var(--line)}
  .cal-cell .ev.start{border-left-color:var(--accent)}
  .cal-cell .ev.end{border-left-color:#a16207}
  .cal-cell .ev.list{border-left-color:var(--good)}
  .cal-cell .ev .tag{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase}
  .cal-cell .ev.start .tag{color:var(--accent)}
  .cal-cell .ev.end .tag{color:#a16207}
  .cal-cell .ev.list .tag{color:var(--good)}
  .cal-cell .ev .co{color:var(--ink);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cal-empty-note{padding:50px 0;text-align:center;color:var(--mute);font-size:13px;font-style:italic}
  @media(max-width:820px){
    .wrap{padding:0 20px}
    .cal-bar{flex-direction:column;align-items:stretch;gap:14px}
    .cal-nav{justify-content:space-between}
    .cal-cell{min-height:78px;padding:6px 5px}
    .cal-dow{padding:6px;font-size:10px}
    .cal-cell .ev{padding:3px 5px;font-size:10px}
    .cal-cell .ev .tag{font-size:8px}
    .cal-cell .ev .co{font-size:10px}
  }
`;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface CalRow {
  stock_code: string;
  company_name: string | null;
  offer_start: string | null;
  offer_end: string | null;
  listing_date: string | null;
}

type CalEventType = "start" | "end" | "list";
interface CalEvent {
  type: CalEventType;
  stock_code: string;
  company_name: string;
  token: string;
}

webRoutes.get("/calendar", async (c) => {
  // "Today" in HKT (UTC+8) so the highlighted day matches user expectations.
  const hktNow = new Date(Date.now() + 8 * 3600 * 1000);
  const todayY = hktNow.getUTCFullYear();
  const todayM = hktNow.getUTCMonth() + 1;
  const todayD = hktNow.getUTCDate();

  // Parse ?m=YYYY-MM, default to current HKT month.
  const mParam = c.req.query("m") || "";
  let year = todayY;
  let month = todayM;
  const mm = /^(\d{4})-(\d{1,2})$/.exec(mParam);
  if (mm) {
    const y = parseInt(mm[1], 10);
    const m = parseInt(mm[2], 10);
    if (y >= 1990 && y <= 9999 && m >= 1 && m <= 12) {
      // Clamp to "no future" — past months only per requirement.
      if (y < todayY || (y === todayY && m <= todayM)) {
        year = y;
        month = m;
      }
    }
  }

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const todayMonthStr = `${todayY}-${String(todayM).padStart(2, "0")}`;
  const isCurrentMonth = year === todayY && month === todayM;

  // Pull every prospectus where any of the three dates falls in the target month.
  const rows = await c.env.DB.prepare(
    `SELECT stock_code, company_name, offer_start, offer_end, listing_date
     FROM prospectus
     WHERE status = 'parsed' AND lang = 'tc'
       AND (
         substr(offer_start, 1, 7)  = ?
         OR substr(offer_end, 1, 7)   = ?
         OR substr(listing_date, 1, 7) = ?
       )`,
  )
    .bind(monthStr, monthStr, monthStr)
    .all<CalRow>();

  const list = rows.results || [];
  const secret = getSecret(c.env);
  const tokenMap = new Map<string, string>();
  await Promise.all(
    list.map(async (r) => {
      tokenMap.set(r.stock_code, await makeToken(r.stock_code, secret));
    }),
  );

  // Bucket events by day-of-month.
  const byDay = new Map<number, CalEvent[]>();
  const pushEvent = (dateStr: string | null, type: CalEventType, r: CalRow) => {
    if (!dateStr || !dateStr.startsWith(monthStr + "-")) return;
    const day = parseInt(dateStr.slice(8, 10), 10);
    if (!day || day < 1 || day > 31) return;
    const arr = byDay.get(day) || [];
    arr.push({
      type,
      stock_code: r.stock_code,
      company_name: r.company_name || r.stock_code,
      token: tokenMap.get(r.stock_code) || "",
    });
    byDay.set(day, arr);
  };
  for (const r of list) {
    pushEvent(r.offer_start, "start", r);
    pushEvent(r.offer_end, "end", r);
    pushEvent(r.listing_date, "list", r);
  }

  // Build the grid.
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  const order: Record<CalEventType, number> = { start: 0, end: 1, list: 2 };
  const tagLabel: Record<CalEventType, string> = { start: "Offer", end: "Close", list: "List" };

  const cells: string[] = [];
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - firstWeekday + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push(`<div class="cal-cell empty"></div>`);
      continue;
    }
    const dowIdx = i % 7;
    const isWeekend = dowIdx === 0 || dowIdx === 6;
    const isToday = isCurrentMonth && dayNum === todayD;
    const events = (byDay.get(dayNum) || []).slice().sort((a, b) => order[a.type] - order[b.type]);

    const evHtml = events
      .map((e) => {
        const tag = tagLabel[e.type];
        const title = `${e.company_name} · ${tag} · ${monthStr}-${String(dayNum).padStart(2, "0")}`;
        return `<a class="ev ${e.type}" href="/co/${esc(e.token)}" title="${esc(title)}"><span class="tag">${tag}</span><span class="co">${esc(e.company_name)}</span></a>`;
      })
      .join("");

    const classes = ["cal-cell"];
    if (isWeekend) classes.push("weekend");
    if (isToday) classes.push("today");
    cells.push(`<div class="${classes.join(" ")}"><div class="num">${dayNum}</div>${evHtml}</div>`);
  }

  // Prev / next month navigation. "Next" disabled when at current month (past-only filter).
  const prevY = month === 1 ? year - 1 : year;
  const prevM = month === 1 ? 12 : month - 1;
  const prevStr = `${prevY}-${String(prevM).padStart(2, "0")}`;
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  const nextStr = `${nextY}-${String(nextM).padStart(2, "0")}`;
  const nextDisabled = isCurrentMonth;

  const dowHtml = DOW_LABELS.map((d) => `<div class="cal-dow">${d}</div>`).join("");
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  const totalEvents = list.length;

  const body = `
<section>
  <div class="cal-head">
    <div class="eyebrow"><span class="dot"></span>HONG KONG MAIN BOARD</div>
    <h1>IPO <em>calendar.</em></h1>
    <p>Offer windows and listing dates across Hong Kong Main Board prospectuses. Pick any past month to see what was in the pipeline. Click an event to open the filing.</p>
  </div>
  <div class="cal-bar">
    <div class="cal-nav">
      <a class="arrow" href="/calendar?m=${prevStr}" aria-label="Previous month">←</a>
      <div class="month-pick">
        <label for="month-input">${esc(monthLabel)}</label>
        <input id="month-input" type="month" value="${monthStr}" max="${todayMonthStr}" onchange="if(this.value)location.href='/calendar?m='+this.value">
      </div>
      <a class="arrow" href="/calendar?m=${nextStr}" aria-label="Next month" aria-disabled="${nextDisabled ? "true" : "false"}">→</a>
      ${isCurrentMonth ? "" : `<a class="today-btn" href="/calendar">Today</a>`}
    </div>
    <div class="cal-legend">
      <span class="lg start">Offer start</span>
      <span class="lg end">Offer end</span>
      <span class="lg list">Listing</span>
    </div>
  </div>
  <div class="cal-grid">
    ${dowHtml}
    ${cells.join("")}
  </div>
  ${totalEvents === 0 ? `<div class="cal-empty-note">No offer or listing events recorded for ${esc(monthLabel)}.</div>` : ""}
</section>
`;
  return c.html(shell(`Calendar — HKIPORadar`, body, CAL_CSS, "calendar"));
});
