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
  board TEXT NOT NULL CHECK (board IN ('Main', 'GEM')),
  status TEXT NOT NULL DEFAULT 'application'
    CHECK (status IN ('application', 'hearing', 'approved', 'listed', 'withdrawn')),
  sponsor TEXT,
  application_date TEXT,
  listing_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS filing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipo_id INTEGER NOT NULL REFERENCES ipo(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  markdown_key TEXT,
  parsed_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipo_id INTEGER NOT NULL REFERENCES ipo(id),
  event_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  source_filing_id INTEGER REFERENCES filing(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ipo_company ON ipo(company_id);
CREATE INDEX IF NOT EXISTS idx_ipo_status ON ipo(status);
CREATE INDEX IF NOT EXISTS idx_filing_ipo ON filing(ipo_id);
CREATE INDEX IF NOT EXISTS idx_filing_source_url ON filing(source_url);
CREATE INDEX IF NOT EXISTS idx_event_ipo ON event(ipo_id);
CREATE INDEX IF NOT EXISTS idx_event_date ON event(event_date);
