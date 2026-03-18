import type { Env } from "../models/types";

// ---------------------------------------------------------------------------
// Aliyun Document AI (文档智能) – Document Parsing (Large-Model Version)
//
// API reference (Chinese):
//   https://help.aliyun.com/zh/document-mind/developer-reference/document-parsing-large-model-version
//
// Three-step async workflow:
//   1. SubmitDocParserJob  – submit a PDF URL for parsing
//   2. QueryDocParserStatus – poll until status === "success"
//   3. GetDocParserResult   – retrieve layout blocks (paginated)
//
// Authentication uses Alibaba Cloud Signature V3 (ACS3-HMAC-SHA256) computed
// entirely with the Web Crypto API so it runs on Cloudflare Workers.
// ---------------------------------------------------------------------------

const DOCMIND_HOST = "docmind-api.cn-hangzhou.aliyuncs.com";
const DOCMIND_ENDPOINT = `https://${DOCMIND_HOST}`;
const API_VERSION = "2022-07-11";

/** Maximum number of status polls before giving up. */
const MAX_POLL_ATTEMPTS = 120;
/** Milliseconds between status polls. */
const POLL_INTERVAL_MS = 3_000;
/** Number of layout blocks to fetch per page. */
const LAYOUT_PAGE_SIZE = 500;

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Parse a prospectus PDF into Markdown via Aliyun Document AI API.
 *
 * Flow:
 * 1. Submit HKEXnews PDF URL directly to Aliyun (avoids transferring large buffers)
 * 2. Poll for completion
 * 3. Retrieve structured layout blocks and convert to Markdown
 * 4. Store Markdown in R2
 * 5. Update filing record in D1
 */
export async function parseFiling(
  env: Env,
  filingId: number
): Promise<string> {
  const filing = await env.DB.prepare(
    "SELECT * FROM filing WHERE id = ?"
  ).bind(filingId).first<{
    id: number;
    source_url: string;
    ipo_id: number;
  }>();

  if (!filing) throw new Error(`Filing ${filingId} not found`);

  // Submit the source URL directly – Aliyun will fetch the PDF itself.
  const markdown = await callAliyunDocParse(env, filing.source_url);

  // Store in R2
  const key = `filings/${filing.ipo_id}/${filing.id}.md`;
  await env.BUCKET.put(key, markdown, {
    customMetadata: {
      filing_id: String(filing.id),
      source_url: filing.source_url,
    },
  });

  // Update D1
  await env.DB.prepare(
    "UPDATE filing SET markdown_key = ?, parsed_at = datetime('now') WHERE id = ?"
  ).bind(key, filing.id).run();

  console.log(`[parser] Parsed filing ${filingId} -> ${key}`);
  return key;
}

// ── Core Aliyun integration ─────────────────────────────────────────────────

/**
 * Full lifecycle: submit → poll → retrieve → convert to Markdown.
 */
async function callAliyunDocParse(
  env: Env,
  pdfUrl: string
): Promise<string> {
  assertAliyunCredentials(env);

  // 1. Submit job ──────────────────────────────────────────────────────────
  const submitParams: Record<string, string> = {
    FileUrl: pdfUrl,
    FileName: filenameFromUrl(pdfUrl),
    LlmEnhancement: "false",
    OutputHtmlTable: "true",      // tables come back as <table> HTML
  };

  const submitResp = await aliyunRpc(env, "SubmitDocParserJob", submitParams);
  const jobId: string | undefined = submitResp?.Data?.Id ?? submitResp?.Id;
  if (!jobId) {
    throw new Error(
      `[parser] SubmitDocParserJob did not return an Id. Response: ${JSON.stringify(submitResp)}`
    );
  }
  console.log(`[parser] Submitted job ${jobId} for ${pdfUrl}`);

  // 2. Poll for completion ────────────────────────────────────────────────
  let status = "";
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const statusResp = await aliyunRpc(env, "QueryDocParserStatus", { Id: jobId });
    status = statusResp?.Data?.Status ?? statusResp?.Status ?? "";
    console.log(`[parser] Job ${jobId} status: ${status} (attempt ${attempt + 1})`);
    if (status === "success") break;
    if (status === "Fail" || status === "fail") {
      throw new Error(`[parser] Job ${jobId} failed. Response: ${JSON.stringify(statusResp)}`);
    }
  }
  if (status !== "success") {
    throw new Error(`[parser] Job ${jobId} timed out after ${MAX_POLL_ATTEMPTS} polls`);
  }

  // 3. Retrieve results (paginated) ──────────────────────────────────────
  const allLayouts: LayoutBlock[] = [];
  let layoutNum = 0;
  while (true) {
    const resultResp = await aliyunRpc(env, "GetDocParserResult", {
      Id: jobId,
      LayoutStepSize: String(LAYOUT_PAGE_SIZE),
      LayoutNum: String(layoutNum),
    });

    const layouts: LayoutBlock[] = resultResp?.Data?.layouts ?? [];
    if (layouts.length === 0) break;
    allLayouts.push(...layouts);
    if (layouts.length < LAYOUT_PAGE_SIZE) break;
    layoutNum += layouts.length;
  }

  // 4. Convert to Markdown ───────────────────────────────────────────────
  return layoutsToMarkdown(allLayouts);
}

// ── Aliyun RPC caller with V3 signature ─────────────────────────────────────

/**
 * Make a signed RPC-style POST to Aliyun Document Mind API.
 *
 * For RPC style, action-specific parameters are passed as **query** parameters.
 * The request body is empty.
 */
async function aliyunRpc(
  env: Env,
  action: string,
  params: Record<string, string>
): Promise<AliyunResponse> {
  const accessKeyId = env.ALIYUN_ACCESS_KEY_ID!;
  const accessKeySecret = env.ALIYUN_ACCESS_KEY_SECRET!;

  // Build query string (action params only – system headers go in HTTP headers)
  const sortedKeys = Object.keys(params).sort();
  const queryParts: string[] = [];
  for (const k of sortedKeys) {
    if (params[k] !== undefined && params[k] !== null) {
      queryParts.push(`${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`);
    }
  }
  const canonicalQueryString = queryParts.join("&");

  // Request body is empty for RPC POST with query params
  const body = "";
  const hashedPayload = await sha256Hex(body);

  // Timestamp & nonce
  const now = new Date();
  const xAcsDate = toIso8601Utc(now);
  const nonce = crypto.randomUUID();

  // Headers that will be signed
  const headers: Record<string, string> = {
    host: DOCMIND_HOST,
    "x-acs-action": action,
    "x-acs-version": API_VERSION,
    "x-acs-date": xAcsDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-content-sha256": hashedPayload,
  };

  // Build canonical headers & signed header list
  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k].trim()}`)
    .join("\n") + "\n";
  const signedHeadersStr = signedHeaderKeys.join(";");

  // Canonical request
  const canonicalRequest = [
    "POST",            // HTTPRequestMethod
    "/",               // CanonicalURI
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersStr,
    hashedPayload,
  ].join("\n");

  // String to sign
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;

  // HMAC-SHA256 signature
  const signature = await hmacSha256Hex(accessKeySecret, stringToSign);

  // Authorization header
  const authorization =
    `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeadersStr},Signature=${signature}`;

  const url = `${DOCMIND_ENDPOINT}/?${canonicalQueryString}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: authorization,
    },
  });

  const respBody = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `[parser] Aliyun ${action} HTTP ${resp.status}: ${respBody}`
    );
  }

  return JSON.parse(respBody) as AliyunResponse;
}

// ── Markdown conversion ─────────────────────────────────────────────────────

interface LayoutBlock {
  type?: string;
  text?: string;
  markdownContent?: string;
  pageNum?: number;
  alignment?: string;
  blocks?: LayoutBlock[];
}

/**
 * Convert Aliyun layout blocks into clean Markdown.
 * Financial tables (returned as HTML when OutputHtmlTable=true) are
 * converted to proper Markdown table syntax.
 */
function layoutsToMarkdown(layouts: LayoutBlock[]): string {
  const parts: string[] = [];

  for (const block of layouts) {
    const md = blockToMarkdown(block);
    if (md) parts.push(md);
  }

  return parts.join("\n\n");
}

function blockToMarkdown(block: LayoutBlock): string {
  const type = (block.type ?? "").toLowerCase();
  const text = (block.markdownContent ?? block.text ?? "").trim();

  if (!text) return "";

  switch (type) {
    case "title":
      return `# ${text}`;

    case "section_title":
    case "section-title":
      return `## ${text}`;

    case "sub_title":
    case "sub-title":
    case "subtitle":
      return `### ${text}`;

    case "table":
      return convertTable(text);

    case "header":
    case "footer":
    case "page_header":
    case "page_footer":
      // Skip page headers/footers – noise for agent consumption
      return "";

    case "image":
    case "figure":
      return `<!-- [Image on page ${block.pageNum ?? "?"}] -->`;

    default:
      // plain text / paragraph
      return text;
  }
}

/**
 * Convert an HTML table (from Aliyun OutputHtmlTable) to Markdown table syntax.
 * Falls back to returning the raw content if it doesn't look like HTML.
 */
function convertTable(html: string): string {
  // If it already looks like markdown table, return as-is
  if (html.includes("|") && !html.includes("<table")) {
    return html;
  }

  // If it's not HTML, just return the text
  if (!html.includes("<") || !html.includes("<t")) {
    return html;
  }

  try {
    return htmlTableToMarkdown(html);
  } catch {
    // Fallback: strip tags and return as code block
    const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return "```\n" + stripped + "\n```";
  }
}

/**
 * Lightweight HTML table → Markdown table converter.
 * Handles <table>, <tr>, <th>, <td> with colspan/rowspan awareness.
 * Works without a DOM parser (Cloudflare Workers has no DOMParser for full HTML).
 */
function htmlTableToMarkdown(html: string): string {
  // Extract rows
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;

  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      // Strip inner tags and normalize whitespace
      const cellText = cellMatch[2]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(cellText);
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) {
    // No rows extracted, strip all tags
    const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return stripped;
  }

  // Normalize column count
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) {
    while (row.length < maxCols) row.push("");
  }

  // Build Markdown table
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const line = "| " + rows[i].map((c) => c.replace(/\|/g, "\\|")).join(" | ") + " |";
    lines.push(line);
    if (i === 0) {
      // Separator after header row
      lines.push("| " + rows[i].map(() => "---").join(" | ") + " |");
    }
  }

  return lines.join("\n");
}

// ── Crypto helpers (Web Crypto API – Cloudflare Workers compatible) ──────────

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(hashBuffer);
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bufferToHex(signed);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ── Utility helpers ─────────────────────────────────────────────────────────

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
function rfc3986Encode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/** Format a Date as ISO 8601 UTC (e.g. "2024-01-15T08:30:00Z"). */
function toIso8601Utc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

/** Extract a filename from a URL path, defaulting to "document.pdf". */
function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/");
    const last = segments[segments.length - 1];
    if (last && last.includes(".")) return last;
  } catch { /* ignore */ }
  return "document.pdf";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAliyunCredentials(env: Env): void {
  if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
    throw new Error(
      "[parser] Missing Aliyun credentials. Set ALIYUN_ACCESS_KEY_ID and " +
      "ALIYUN_ACCESS_KEY_SECRET as secrets in wrangler."
    );
  }
}

// ── Types for Aliyun responses ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AliyunResponse = Record<string, any>;
