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
  status: "offering" | "listed" | "withdrawn";
  sponsor: string | null;
  listing_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Filing {
  id: number;
  ipo_id: number;
  lang: "en" | "tc";
  category: string;
  title: string;
  source_url: string;
  markdown_key: string | null; // R2 object key for parsed markdown
  parsed_at: string | null;
  discovered_at: string;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Aliyun AccessKey ID for Document AI API authentication. */
  ALIYUN_ACCESS_KEY_ID?: string;
  /** Aliyun AccessKey Secret for Document AI API authentication. */
  ALIYUN_ACCESS_KEY_SECRET?: string;
}
