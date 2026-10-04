# ADR-002: Embedded library, not a standalone agent process

## Status
Accepted

## Context
Metrics/observability tools commonly run as a separate agent process (a sidecar or
daemon) that the instrumented app ships events to over a socket or HTTP, decoupling
capture from storage and giving the agent its own back-pressure buffering. The README
explicitly lists "standalone agent process with back-pressure buffering" as out of
scope for Wolter.

## Decision
Wolter runs entirely in-process as a `DynamicModule` (`WolterModule.forRoot()`) inside
the host NestJS app: the interceptor, watchers, aggregator, and SQLite file all live in
the same Node process as the app they're monitoring.

## Alternatives Considered
- **Standalone agent + IPC/HTTP shipping** — decouples capture from the host app's
  event loop and survives a host crash with its own buffer, but adds a process to
  deploy, monitor, and keep in sync with the app's lifecycle — infrastructure a
  single self-hosted app explicitly doesn't want.
- **Sidecar container** — same trade-off, worse for the "add a package, not an
  ops burden" install story.

## Consequences
- Positive: install is `npm install` + one module import; no second process to deploy,
  restart, or monitor; trivially matches the app's own lifecycle
  (`OnApplicationShutdown` flushes and closes storage together with the host).
- Negative: a hard crash of the host process takes Wolter's in-memory buffer down with
  it — see [[003]] for the bounded blast radius this actually has.
- Negative: capture work runs on the same event loop as the app it's instrumenting, so
  every watcher must be cheap and non-blocking by construction (the codebase's
  recurring try/catch-and-swallow discipline around `Recorder` exists because of this).

## Trade-offs
Zero-infrastructure installability is prioritized over crash isolation and independent
scaling — the explicit trade the README's "out of scope" list already commits to.
