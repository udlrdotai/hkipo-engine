-- hkipo-engine D1 schema

-- 公司信息表
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,                              -- 英文名称
  name_tc TEXT NOT NULL DEFAULT '',                    -- 繁体中文名称
  stock_code TEXT,                                     -- 股份代号（如 2632）
  industry TEXT,                                       -- 行业
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- IPO 上市记录表
CREATE TABLE IF NOT EXISTS ipo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES company(id),
  board TEXT NOT NULL DEFAULT 'Main',                  -- 上市板块（仅主板）
  status TEXT NOT NULL DEFAULT 'offering'              -- 状态：发售中 / 已上市 / 已撤回
    CHECK (status IN ('offering', 'listed', 'withdrawn')),
  sponsor TEXT,                                        -- 保荐人
  listing_date TEXT,                                   -- 上市日期
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 文件记录表（招股书 PDF 来源）
CREATE TABLE IF NOT EXISTS filing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ipo_id INTEGER NOT NULL REFERENCES ipo(id),
  lang TEXT NOT NULL DEFAULT 'en'                      -- 语言：en 英文 / tc 繁体中文
    CHECK (lang IN ('en', 'tc')),
  category TEXT NOT NULL,                              -- 文件分类（如 Listing Document）
  title TEXT NOT NULL,                                 -- 文件标题
  source_url TEXT NOT NULL UNIQUE,                     -- HKEXnews PDF 下载地址
  discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 招股书结构化数据表（独立表，不关联 company/ipo）
CREATE TABLE IF NOT EXISTS prospectus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT UNIQUE NOT NULL,                     -- 股份代号
  company_name_tc TEXT,                                -- 公司繁体中文名称
  company_name_en TEXT,                                -- 公司英文名称
  industry TEXT,                                       -- 行业
  board TEXT,                                          -- 上市板块
  listing_date TEXT,                                   -- 上市日期
  offer_start TEXT,                                    -- 公开发售开始日
  offer_end TEXT,                                      -- 公开发售截止日
  price_low REAL,                                      -- 发售价下限
  price_high REAL,                                     -- 发售价上限
  currency TEXT,                                       -- 货币（如 HKD）
  net_proceeds REAL,                                   -- 估计所得款项净额
  business_summary TEXT,                               -- 主营业务描述
  dividend_policy TEXT,                                -- 股息政策
  offering TEXT,                                       -- 发售详情（JSON）
  timeline TEXT,                                       -- 预期时间表（JSON）
  sponsors TEXT,                                       -- 保荐人及中介机构（JSON）
  financials TEXT,                                     -- 财务数据：损益表、资产负债表、现金流（JSON）
  use_of_proceeds TEXT,                                -- 募资用途（JSON）
  cornerstone_investors TEXT,                          -- 基石投资者（JSON）
  shareholders TEXT,                                   -- 主要股东（JSON）
  risk_factors TEXT,                                   -- 风险因素（JSON）
  financial_risks TEXT,                                -- 财务风险（JSON）
  status TEXT NOT NULL DEFAULT 'pending'               -- 处理状态：待处理 / 已爬取 / 已解析 / 失败
    CHECK (status IN ('pending', 'crawled', 'parsed', 'failed')),
  source_pdf_key TEXT,                                 -- PDF 原件存储路径
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ipo_company ON ipo(company_id);
CREATE INDEX IF NOT EXISTS idx_ipo_status ON ipo(status);
CREATE INDEX IF NOT EXISTS idx_filing_ipo ON filing(ipo_id);
CREATE INDEX IF NOT EXISTS idx_filing_source_url ON filing(source_url);
CREATE INDEX IF NOT EXISTS idx_filing_lang ON filing(lang);
CREATE INDEX IF NOT EXISTS idx_prospectus_stock_code ON prospectus(stock_code);
CREATE INDEX IF NOT EXISTS idx_prospectus_listing_date ON prospectus(listing_date);
CREATE INDEX IF NOT EXISTS idx_prospectus_status ON prospectus(status);
