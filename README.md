# hkipo-engine

> Agent-first structured data and alerts for Hong Kong IPO filings.

`hkipo-engine` is a machine-readable intelligence layer for Hong Kong IPO filings.

It is designed to turn raw IPO documents and listing events into structured data that can be consumed by agents, workflows, internal tools, and research systems. Instead of building another human-facing IPO portal, this project focuses on parsing, normalizing, and tracking Hong Kong IPO prospectuses in a format that is reliable, traceable, and automation-friendly.

## Why this project exists

Most existing IPO websites are built for humans:
- calendars
- listing pages
- broker subscription flows
- news and commentary

They are useful for browsing, but not ideal for agents.

Agents need:
- stable schemas
- structured fields
- event timelines
- versioned filings
- source grounding
- machine-readable outputs

`hkipo-engine` aims to provide that missing layer for Hong Kong IPO data.

## What hkipo-engine does

The project is built around three core ideas:

1. **Filing ingestion**
   - track Hong Kong IPO filings and listing-related events
   - detect new filings, updates, and status changes
   - maintain a normalized event timeline

2. **Prospectus parsing**
   - extract key structured fields from prospectuses
   - identify financial highlights, use of proceeds, risk factors, and offering details
   - preserve references back to source documents whenever possible

3. **Agent-ready interfaces**
   - expose machine-readable outputs for downstream systems
   - support APIs, feeds, automation workflows, and alerting pipelines
   - make IPO data easy to consume in research or agent environments

## Project goals

- Build an **agent-first** data engine for Hong Kong IPO filings
- Normalize raw prospectus content into a consistent schema
- Make important IPO events queryable and trackable over time
- Support alerting and automation on top of filing changes
- Keep outputs transparent and source-linked

## Non-goals

This project is **not** intended to be:
- an IPO subscription platform
- an investment advice product
- a broker integration layer
- a recommendation engine for whether to subscribe to an offering

The focus is on **data infrastructure**, not investment advice.

## Core objects

The long-term data model is centered around the following entities:

- **Company**
- **IPO**
- **Filing**
- **Event**
- **Financials**
- **RiskFactor**
- **OfferingTerms**
- **UseOfProceeds**

These objects are designed to support both human review and machine consumption.

## Example use cases

- track newly submitted Hong Kong IPO applications
- monitor changes between updated prospectus versions
- generate alerts for listing milestones
- build internal dashboards for IPO monitoring
- feed structured IPO data into AI agents
- power search, screening, and downstream analytics

## Design principles

### 1. Agent-first
Outputs should be usable by agents without additional scraping or brittle parsing.

### 2. Source-grounded
Structured outputs should remain linked to their source documents and sections whenever possible.

### 3. Schema-stable
The data model should be predictable enough for automation and downstream integrations.

### 4. Event-driven
IPO activity should be represented as a timeline of state changes, not just static snapshots.

### 5. Minimal opinionation
This project focuses on extracting and organizing information, not making investment recommendations.

## Planned architecture

```text
HKEX / issuer filings
        ↓
   ingestion layer
        ↓
    document parser
        ↓
   normalized schema
        ↓
 event timeline + storage
        ↓
 API / feed / alerts / agent tools
