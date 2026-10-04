# ADR-003: Buffered in-memory aggregation, not write-through

## Status
Accepted

## Context
Every captured HTTP request/query/job/cache event needs to turn into an updated
metric bucket (count, percentiles, error/slow counts) for the dashboard's trend
charts. Writing a SQLite row on every single event would mean one disk write per
request on the host app's hot path.

## Decision
`Aggregator` buffers events in memory per `(category, label, window)` key and flushes
to `SqliteStorage.write()` on a timer (periodic flush), using a streaming TDigest for
percentile estimation instead of storing every raw duration. `EventLog` writes raw
per-occurrence events separately, for drill-down rather than aggregation.

## Alternatives Considered
- **Write-through (one SQLite write per event)** — simplest to reason about, zero
  buffer-loss window, but couples every request's latency to a synchronous disk write
  and would make SQLite's single-writer behavior a hot-path bottleneck under load.
- **Exact percentiles (store all durations, compute on read)** — perfectly accurate,
  but unbounded memory growth per bucket under sustained traffic; TDigest trades a
  small, bounded approximation error for O(1)-ish memory per bucket.

## Consequences
- Positive: request path only touches an in-memory map, not disk; write volume to
  SQLite drops from "one row per event" to "one upsert per bucket per flush interval."
- Negative: the currently-open bucket lives only in memory until the next flush — an
  unclean crash loses that window (bounded to one flush interval; see the Risks table
  in `../ARCHITECTURE.md`).
- Negative: percentiles are approximate (TDigest), not exact — acceptable for a
  trend dashboard, not for billing or SLA-contractual reporting.

## Trade-offs
Hot-path latency and write volume are prioritized over perfect durability and exact
percentiles — appropriate for an observability dashboard, not a system of record.
