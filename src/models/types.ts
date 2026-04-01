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
  board: "Main";
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
  discovered_at: string;
}

export interface Env {
  DB: D1Database;
  ADMIN_API_KEY: string;
}
