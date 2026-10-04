# Wolter

Self-hosted production metrics dashboard for NestJS. See what's burning in production.

## Packages

- `@wolter/core`: plugin registry, aggregation engine, SQLite storage, dashboard (`/wolter`)
- `@wolter/typeorm`: TypeORM query watcher
- `@wolter/bullmq`: BullMQ job watcher
- `@wolter/cache`: Cache Manager hit/miss watcher
- `@wolter/node`: Node.js runtime metrics
- `@wolter/migrate`: generates a TypeORM/Prisma/raw-SQL migration for a custom storage driver's tables

## Storage

By default, `WolterModule.forRoot()` writes to a SQLite file at `./wolter.db` (plus the
`-wal`/`-shm` files SQLite's WAL mode keeps alongside it). Set a different location:

```ts
WolterModule.forRoot({
  storage: { path: './data/wolter.db' },
});
```

Tables are named `wolter_metrics`/`wolter_events` by default, so pointing `path` at a
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

A custom driver needs its own `wolter_metrics`/`wolter_events` tables in your database.
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

### Next up

- **Exception → issue lifecycle**: group exceptions by fingerprint into tracked issues with status/priority/assignee/comments, instead of raw occurrence logs. Now that trace correlation exists, issues can link straight to the requests that triggered them.
- **Alerting**: Slack/Discord/webhook (HMAC-signed) notifications on new issues or threshold breaches.
- **Per-route/per-job thresholds**: replace the single global `slowQueryThreshold` with configurable thresholds per route and per job.
- **Granular data clearing**: clear stored data by table, date range, route, or status code, with a row-count preview before delete.

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
