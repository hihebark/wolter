# ADR-005: Duck-typed plugin interface over decorator/AOP instrumentation

## Status
Accepted

## Context
Wolter needs to capture events from libraries it doesn't control — TypeORM query
execution, BullMQ job processing, a cache-manager instance — as opt-in packages
(`@wolter/typeorm`, `@wolter/bullmq`, `@wolter/cache`) that a host only installs if it
uses that library, per the README's package list.

## Decision
Each plugin implements a small `WolterPlugin` interface (bootstrap/shutdown lifecycle,
registered with a `PluginRegistry`) and hooks its target library using whatever
mechanism fits that library's own API — a query subscriber for TypeORM, event
listeners for BullMQ, and a `Proxy` wrapping the cache-manager instance's methods
(`CachePlugin.wrap()`) to intercept get/set calls without subclassing or requiring the
host to change how it calls the cache.

## Alternatives Considered
- **Decorator/AOP-based instrumentation** (e.g. requiring `@Traced()` on methods, or a
  NestJS interceptor per watched provider) — more uniform across plugins, but requires
  the host app to annotate its own code or re-wire providers just to get metrics,
  adding integration friction the README's "add a package" install story avoids.
- **Monkey-patching the target library's prototype globally** — no wrapping needed at
  the call site, but affects every instance in the process (including ones the host
  didn't intend to monitor) and breaks if the library's internals shift between minor
  versions more easily than its public instance API does.

## Consequences
- Positive: a plugin can be added or removed independently, with no changes to host
  application code beyond passing the existing library instance in; each plugin
  hooks its target the idiomatic way for that specific library.
- Negative: no single unifying instrumentation mechanism across plugins — each new
  plugin (e.g. a future outgoing-HTTP-call watcher) needs its own integration
  strategy rather than reusing a generic AOP layer.
- Negative: `Proxy`-based wrapping (`CachePlugin`) must forward `this` binding
  correctly for methods that rely on it — a real bug class already hit and fixed in
  this codebase (unbound-method Proxy trap).

## Trade-offs
Low integration friction per library is prioritized over a single uniform
instrumentation abstraction — appropriate for a small, fixed set of opt-in plugins,
not a general-purpose AOP framework.
