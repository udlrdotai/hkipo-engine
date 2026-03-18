/** Core entity types for hkipo-engine */

export interface Company {
  id: number;
  name_en: string;
  name_tc: string;
  stock_code: string | null;
  industry: string | null;
  created_at: string;
}

export interface IPO {
  id: number;
  company_id: number;
  board: "Main" | "GEM";
  status: "application" | "hearing" | "approved" | "listed" | "withdrawn";
  sponsor: string | null;
  application_date: string | null;
  listing_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Filing {
  id: number;
  ipo_id: number;
  category: string;
  title: string;
  source_url: string;
  markdown_key: string | null; // R2 object key for parsed markdown
  parsed_at: string | null;
  discovered_at: string;
}

export interface Event {
  id: number;
  ipo_id: number;
  event_type: string;
  description: string;
  event_date: string;
  source_filing_id: number | null;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Aliyun AccessKey ID for Document AI API authentication. */
  ALIYUN_ACCESS_KEY_ID?: string;
  /** Aliyun AccessKey Secret for Document AI API authentication. */
  ALIYUN_ACCESS_KEY_SECRET?: string;
}
