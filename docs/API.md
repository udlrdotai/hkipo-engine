# hkipo-engine API 文档

Base URL: `https://hkipo-engine.gankthisway.workers.dev`

---

## 公开接口

### 1. 健康检查

```
GET /
```

**响应示例：**

```json
{ "name": "hkipo-engine", "status": "ok" }
```

---

### 2. IPO 列表

```
GET /api/ipo/
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 否 | 过滤状态：`offering` / `listed` / `withdrawn` |
| board | string | 否 | 过滤板块：`Main` |

**响应示例：**

```json
[
  {
    "id": 1,
    "company_id": 1,
    "board": "Main",
    "status": "offering",
    "sponsor": null,
    "listing_date": null,
    "created_at": "2026-03-18T10:00:00",
    "updated_at": "2026-03-18T10:00:00",
    "name_en": "Example Corp",
    "name_tc": "範例公司",
    "stock_code": "2632"
  }
]
```

---

### 3. IPO 详情

```
GET /api/ipo/:id
```

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| id | number | IPO 记录 ID |

**响应示例：**

```json
{
  "id": 1,
  "company_id": 1,
  "board": "Main",
  "status": "offering",
  "sponsor": null,
  "listing_date": null,
  "name_en": "Example Corp",
  "name_tc": "範例公司",
  "stock_code": "2632",
  "filings": [
    {
      "id": 1,
      "ipo_id": 1,
      "lang": "en",
      "category": "Listing Document",
      "title": "Prospectus",
      "source_url": "https://www1.hkexnews.hk/...",
      "discovered_at": "2026-03-18T10:00:00"
    }
  ]
}
```

**错误响应：**

| 状态码 | 说明 |
|--------|------|
| 404 | IPO 不存在 |

---

### 4. 招股书文件元数据

```
GET /api/filing/:id
```

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| id | number | Filing 记录 ID |

**响应示例：**

```json
{
  "id": 1,
  "ipo_id": 1,
  "lang": "en",
  "category": "Listing Document",
  "title": "Prospectus",
  "source_url": "https://www1.hkexnews.hk/...",
  "discovered_at": "2026-03-18T10:00:00"
}
```

**错误响应：**

| 状态码 | 说明 |
|--------|------|
| 404 | Filing 不存在 |

---

## 管理接口

所有 `/admin/api/*` 接口需要 Bearer Token 认证。

**请求头：**

```
Authorization: Bearer <ADMIN_API_KEY>
```

**认证失败响应：**

| 状态码 | 说明 |
|--------|------|
| 401 | 缺少或格式错误的 Authorization 头 |
| 403 | Token 无效 |

---

### 5. 手动触发爬取

```
POST /admin/api/discover
```

手动触发从港交所网站爬取最新 Main Board 上市信息。正常情况下由 cron 定时执行（周一至周五 09:00-18:00 HKT，每 30 分钟一次）。

**响应示例：**

```json
{
  "parsed": { "mainEn": 10, "mainTc": 10 },
  "newFilings": 3
}
```

---

### 6. 查询待处理招股书

```
GET /admin/api/prospectus/pending
```

返回所有 `status = 'pending'` 的招股书记录。

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lang | string | 否 | 过滤语言：`en` / `tc` |

**响应示例：**

```json
[
  {
    "stock_code": "2632",
    "lang": "en",
    "source_url": "https://www1.hkexnews.hk/.../prospectus_en.pdf",
    "company_name": "Example Corp",
    "status": "pending",
    "created_at": "2026-03-18T10:00:00"
  }
]
```

---

### 7. 提交招股书解析数据

```
POST /admin/api/prospectus
```

提交 VPS 解析后的结构化招股书数据。按 `(stock_code, lang)` 做 upsert，存在则更新，不存在则插入。提交成功后状态自动设为 `parsed`。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| stock_code | string | 是 | 股份代号 |
| lang | string | 否 | 语言：`en` / `tc` |
| source_url | string | 否 | PDF 来源 URL |
| company_name | string | 否 | 公司名称 |
| industry | string | 否 | 行业 |
| board | string | 否 | 上市板块 |
| listing_date | string | 否 | 上市日期（ISO 8601） |
| offer_start | string | 否 | 公开发售开始日 |
| offer_end | string | 否 | 公开发售截止日 |
| price_low | number | 否 | 发售价下限 |
| price_high | number | 否 | 发售价上限 |
| currency | string | 否 | 货币（如 HKD） |
| net_proceeds | number | 否 | 估计所得款项净额 |
| business_summary | string | 否 | 主营业务描述 |
| dividend_policy | string | 否 | 股息政策 |
| offering | object | 否 | 发售详情（存为 JSON） |
| timeline | object | 否 | 预期时间表（存为 JSON） |
| sponsors | object | 否 | 保荐人及中介机构（存为 JSON） |
| financials | object | 否 | 财务数据（存为 JSON） |
| use_of_proceeds | array | 否 | 募资用途（存为 JSON） |
| cornerstone_investors | array | 否 | 基石投资者（存为 JSON） |
| shareholders | object | 否 | 主要股东（存为 JSON） |
| risk_factors | array | 否 | 风险因素（存为 JSON） |
| financial_risks | object | 否 | 财务风险（存为 JSON） |

**请求示例：**

```json
{
  "stock_code": "2632",
  "lang": "tc",
  "company_name": "江蘇新視界",
  "industry": "醫療器械",
  "board": "Main",
  "listing_date": "2026-04-15",
  "price_low": 42.00,
  "price_high": 48.00,
  "currency": "HKD",
  "financials": {
    "currency": "RMB",
    "unit": "千元",
    "income_statement": [
      { "period": "FY2023", "revenue": 500000, "net_profit": 80000 }
    ]
  },
  "cornerstone_investors": [
    { "name": "盈科壹號", "amount": 55.0, "currency": "USD", "unit": "百萬" }
  ]
}
```

**响应示例：**

```json
{ "ok": true, "stock_code": "2632", "lang": "tc" }
```

**错误响应：**

| 状态码 | 说明 |
|--------|------|
| 400 | 缺少 stock_code 或 lang 值无效 |

---

### 8. 更新招股书状态

```
PATCH /admin/api/prospectus/:stock_code/:lang/status
```

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| stock_code | string | 股份代号 |
| lang | string | 语言：`en` / `tc` |

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 是 | `pending` / `crawled` / `parsed` / `failed` |

**请求示例：**

```json
{ "status": "crawled" }
```

**响应示例：**

```json
{ "ok": true, "stock_code": "2632", "lang": "en", "status": "crawled" }
```

**错误响应：**

| 状态码 | 说明 |
|--------|------|
| 400 | lang 或 status 值无效 |
| 404 | 对应的招股书记录不存在 |
