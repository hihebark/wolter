# ADR-001: SQLite as the only v0.1 storage driver

## Status
Accepted

## Context
Wolter needs somewhere to persist aggregated metric buckets and raw events for a
self-hosted, single-app NestJS library. The README rules out a hosted multi-tenant
backend and a column-store ingest pipeline for this version — whatever is chosen must
run with zero external infrastructure.

## Decision
Use `better-sqlite3` (`SqliteStorage`) as the sole `WolterStorageDriver` implementation,
in WAL mode, as a single file colocated with the host app.

## Alternatives Considered
- **Postgres/MySQL** — better concurrent-write behavior, but requires the host to stand
  up and operate a separate DB server, contradicting "zero external infrastructure."
- **Flat files / JSON log** — no dependency at all, but loses indexed range queries
  (`idx_metrics_category_ts`, `idx_events_trace_id`) needed for the dashboard's range
  filters and trace correlation without scanning everything.
- **In-memory only (no persistence)** — simplest, but metrics vanish on every restart,
  defeating the point of a production dashboard.

## Consequences
- Positive: zero ops burden, single file to back up or delete, synchronous
  `better-sqlite3` API keeps the storage layer simple (no connection pool, no async
  driver edge cases).
- Negative: single-writer — concurrent writes from multiple app instances/processes
  sharing one file will contend or must be avoided entirely (see [[002]]).
- Negative: no network access to the data without shipping the file or building a
  network-facing driver.

`WolterStorageDriver` was kept narrow enough that a host isn't locked into SQLite: a
custom driver instance can be passed via `storage: { driver: 'custom', instance }` in
`WolterModule.forRoot()`, so a Postgres/network driver is a drop-in swap a host can
write today, not a hypothetical future one.

## Trade-offs
Operational simplicity is prioritized over concurrent-write throughput and remote
access — consistent with the "single self-hosted app" scope, not a hosted service.
