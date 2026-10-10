# Wolter

Self-hosted production metrics dashboard for NestJS. See what's burning in production.

## Packages

- `@wolter/core`: plugin registry, aggregation engine, SQLite storage, dashboard (`/wolter`)
- `@wolter/typeorm`: TypeORM query watcher
- `@wolter/bullmq`: BullMQ job watcher
- `@wolter/cache`: Cache Manager hit/miss watcher
- `@wolter/node`: Node.js runtime metrics
- `@wolter/migrate`: generates a TypeORM/Prisma/raw-SQL migration for a custom storage driver's tables

## Dashboard access

The dashboard shows everything Wolter captured from other people's requests (URLs with
query strings, and headers/bodies/SQL parameters when you turn those on), so it needs a
guard. `WolterModule.forRoot()` refuses to start with the dashboard enabled and no guard,
unless `NODE_ENV` is explicitly `development` or `test`:

```ts
WolterModule.forRoot({
  dashboard: { guard: AdminGuard }, // any Nest CanActivate class
});
```

If access is already restricted some other way (private network, auth at the proxy), opt out
explicitly with `dashboard: { allowUnauthenticated: true }`, or turn the dashboard off with
`dashboard: { enabled: false }`.

## How events are grouped

Each dashboard row is a group, and Wolter never builds a group from request data, so
clients can't create unlimited rows:

- **HTTP:** by route template (`GET /products/:id`). Unmatched paths share one `(unmatched)` group.
- **Exceptions:** by class and the place in your code that threw, e.g.
  `NotFoundException at ProductsService.findOne (src/products/products.service.ts)`.
  Each occurrence still shows its full message.
- **Cache:** by key namespace (`user:123` → `user`, `/products/42?q=x` → `/products`). For finer
  groups, pass your own mapping, keeping request values out of it:
  `new CachePlugin({ keyLabel: (key) => key.split(':').slice(0, 2).join(':') })`.

As a backstop, each category keeps at most 500 groups per minute; extra events are counted
under `(other)`, a warning is logged, and the dashboard shows a banner.

## Slow thresholds

A request is "slow" above `thresholds.default` (500ms if unset). Override it per route with
the route template, for one method or all of them:

```ts
WolterModule.forRoot({
  thresholds: {
    default: 300,
    routes: { 'GET /reports/:id': 5_000, '/exports/:id': 30_000 },
  },
});
```

Jobs get durations from `BullMQPlugin` (one Redis lookup per finished job) and are slow above
their queue's threshold. Without thresholds, jobs are only slow when BullMQ reports them stalled:

```ts
new BullMQPlugin({ queues: [emails, reports], thresholds: { default: 10_000, queues: { reports: 120_000 } } });
```

## Issues

Each exception group is an issue: open on first sight, then triaged from the exception's page
on the dashboard (status open/resolved/ignored, priority, assignee, comments). A resolved issue
reopens by itself if the error happens again, with a comment saying so. Comment authors come
from `req.user` (`name`, `username`, `email` or `id`) when your guard sets it; otherwise the
dashboard asks for a name. Issues are kept when metrics age out or are cleared.

## Clearing data

The dashboard's Data page deletes stored metrics and/or raw events by category, exact route or
label, date range, and status code (raw events only). It shows a row count first, and Delete
only runs the filter you just previewed.

Issue changes and data clearing are writes, protected by the same `dashboard.guard` as viewing.
Every write must also send an `x-wolter-request: 1` header, which the dashboard does for you; a
page on another site can't set it, so it can't make a logged-in viewer's browser delete data.

## Storage

By default, `WolterModule.forRoot()` writes to a SQLite file at `./wolter.db` (plus the
`-wal`/`-shm` files SQLite's WAL mode keeps alongside it). Set a different location:

```ts
WolterModule.forRoot({
  storage: { path: './data/wolter.db' },
});
```

Tables are named `wolter_metrics`/`wolter_events`/`wolter_routes`/`wolter_labels` by default, so pointing `path` at a
SQLite file the host app already uses (or a shared custom driver's database, below)
won't collide with its own tables. Override the prefix if you need to:

```ts
WolterModule.forRoot({
  storage: { tablePrefix: 'myapp_wolter_' },
});
```

Or bring your own storage by implementing `WolterStorageDriver` and passing an instance.
Wolter calls `instance.close?.()` on app shutdown the same as it would for its own
SqliteStorage:

```ts
WolterModule.forRoot({
  storage: { driver: 'custom', instance: new MyPostgresDriver(pool) },
});
```

Issue tracking and the Data page need two optional members, `issues` (an `IssueStore`) and
`clearData(filter, dryRun)`; a driver without them still works, and those dashboard
features answer 501. `@wolter/migrate` generates the `issues`/`issue_comments` tables too.

Two driver hooks matter for performance and size. Implement the optional
`writeBatch(buckets)` to write each flush (every bucket that changed in the last 5s) in
one transaction; without it Wolter falls back to one `write()` per bucket. And honor
`prune(olderThan, maxRowsPerCategory)`'s second argument, which caps stored metric
buckets per category (oldest first) on top of age-based retention. The cap defaults to
100000 and is configurable:

```ts
WolterModule.forRoot({
  retention: '7d',
  metrics: { maxRowsPerCategory: 250_000 },
});
```

A custom driver needs its own `wolter_metrics`/`wolter_events` tables in your database, plus the
`wolter_routes`/`wolter_labels` lookup tables behind `resolveRoute()`/`resolveLabel()`.
Wolter never creates or migrates them for you (unlike SqliteStorage, which owns its own
private file). `@wolter/migrate` generates that migration for you to review and run with
your own tooling. It never touches your database itself:

```bash
npx @wolter/migrate generate --target typeorm --dir src/migrations   # or: --target prisma | --target sql
```

`--target` is `typeorm` (a `MigrationInterface` file), `prisma` (a schema snippet to
append to `schema.prisma`), or `sql` (a plain `.sql` file, pick `--dialect postgres|mysql|sqlite`).
`--prefix` matches whatever you set in `storage.tablePrefix` above (default `wolter_`).

## Roadmap

Ideas pulled from NightOwl and Laravel Nightwatch, scoped down to fit a free, self-hosted, single-app NestJS library rather than a hosted multi-tenant SaaS.

### Done

- **Trace correlation**: `TraceContext` (AsyncLocalStorage) tags http/exception/query events with a shared `traceId` per inbound request. A "Correlated trace" waterfall (`GET /api/trace/:traceId`) is available on any event with a trace in the dashboard's Recent Occurrences panel.
- **Log correlation**: `WolterLoggerPlugin` extends Nest's `ConsoleLogger`, so passing it to both `plugins: [...]` and `app.useLogger(...)` gets you identical console output plus every `logger.log/warn/error/...` call made during a request showing up inline in that request's trace waterfall (only when a trace is active; startup/cron logs aren't correlated to anything, so they stay plain console output):

  ```ts
  const wolterLogger = new WolterLoggerPlugin();
  // in WolterModule.forRoot({ plugins: [wolterLogger, ...] })
  app.useLogger(wolterLogger);
  ```
- **Plugin liveness**: a plugin that throws during `register()` used to only reach `console.error`, invisible from the dashboard. `PluginRegistry` now tracks each plugin's registration outcome, surfaced on `GET /wolter/api/health` (`plugins: [{ name, category, active, error? }]`) and as a status dot in the dashboard header next to the storage health dot: green when every plugin registered, red (with per-plugin errors in the tooltip) when one didn't. Hidden when no plugins are configured.

- **Exception → issue lifecycle**: every exception group is a tracked issue (see [Issues](#issues)).
- **Per-route/per-job thresholds**: see [Slow thresholds](#slow-thresholds).
- **Granular data clearing**: the dashboard's Data page (see [Clearing data](#clearing-data)).

### Next up

- **Alerting**: Slack/Discord/webhook (HMAC-signed) notifications on new issues or threshold breaches.

### Later

- Outgoing HTTP call tracing (axios/fetch interceptor plugin)
- Scheduled task monitoring (watch the app's own `@nestjs/schedule` cron jobs)
- Multi-environment stamping (tag events with env from one token/config)

### Explicitly out of scope

Hosted multi-tenant infrastructure problems, not self-hosted single-app ones:

- MCP/AI tool server
- Column-store ingest pipeline for billions of events
- SOC2/multi-region compliance
- Standalone agent process with back-pressure buffering
