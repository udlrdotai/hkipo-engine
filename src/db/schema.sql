-- hkipo-engine D1 schema

CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_tc TEXT NOT NULL DEFAULT '',
  stock_code TEXT,
  industry TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ipo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES company(id),
  board TEXT NOT NULL DEFAULT 'Main',
  status TEXT NOT NULL DEFAULT 'offering'
    CHECK (status IN ('offering', 'listed', 'withdrawn')),
  sponsor TEXT,
  listing_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS filing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipo_id INTEGER NOT NULL REFERENCES ipo(id),
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'tc')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  markdown_key TEXT,
  parsed_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prospectus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT UNIQUE NOT NULL,
  company_name_tc TEXT,
  company_name_en TEXT,
  industry TEXT,
  board TEXT,
  listing_date TEXT,
  offer_start TEXT,
  offer_end TEXT,
  price_low REAL,
  price_high REAL,
  currency TEXT,
  net_proceeds REAL,
  business_summary TEXT,
  dividend_policy TEXT,
  offering TEXT,
  timeline TEXT,
  sponsors TEXT,
  financials TEXT,
  use_of_proceeds TEXT,
  cornerstone_investors TEXT,
  shareholders TEXT,
  risk_factors TEXT,
  financial_risks TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'crawled', 'parsed', 'failed')),
  source_pdf_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ipo_company ON ipo(company_id);
CREATE INDEX IF NOT EXISTS idx_ipo_status ON ipo(status);
CREATE INDEX IF NOT EXISTS idx_filing_ipo ON filing(ipo_id);
CREATE INDEX IF NOT EXISTS idx_filing_source_url ON filing(source_url);
CREATE INDEX IF NOT EXISTS idx_filing_lang ON filing(lang);
CREATE INDEX IF NOT EXISTS idx_prospectus_stock_code ON prospectus(stock_code);
CREATE INDEX IF NOT EXISTS idx_prospectus_listing_date ON prospectus(listing_date);
CREATE INDEX IF NOT EXISTS idx_prospectus_status ON prospectus(status);
