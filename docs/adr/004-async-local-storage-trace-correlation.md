# ADR-004: AsyncLocalStorage for trace correlation

## Status
Accepted

## Context
The dashboard's trace view (`GET /api/trace/:traceId`) needs to show every event
captured across categories (HTTP request, DB queries, cache hits, exceptions) that
happened while handling one inbound request — even though those events are recorded
from unrelated call sites (a TypeORM query subscriber, a cache Proxy, the HTTP
interceptor) with no explicit reference to each other.

## Decision
Tag every inbound request with a trace ID in `WolterTraceMiddleware` using Node's
`AsyncLocalStorage`, so any code running within that request's async context —
regardless of which plugin or watcher it is — can read the current trace ID and stamp
it onto whatever event it records, with no parameter threading required.

## Alternatives Considered
- **Explicit trace ID parameter threading** — pass a trace ID through every function
  call from the interceptor down into each watcher; correct, but would require every
  plugin author to thread an extra parameter through library code they don't own
  (TypeORM's own query execution, cache-manager's own get/set), which isn't feasible
  without forking those libraries.
- **Header/context object attached to the request** — works for HTTP-triggered code
  with access to the request object, but plugins like the cache watcher wrap calls
  that don't always carry a request reference at the call site.

## Consequences
- Positive: any plugin can call a single "get current trace ID" function and just
  work, with no coupling to how the ID got there or who's downstream of it.
- Negative: `AsyncLocalStorage` context is lost across manual `setImmediate`/raw
  `Promise` boundaries that don't propagate the async context correctly — a watcher
  written carelessly could silently stamp events with no trace ID rather than erroring.
- Negative: small, fixed per-async-context overhead versus explicit passing, generally
  negligible compared to actual I/O in this codebase's watchers.

## Trade-offs
Correlation that works transparently across independently-authored plugins is
prioritized over the explicitness (and slightly lower overhead) of manual parameter
threading.
