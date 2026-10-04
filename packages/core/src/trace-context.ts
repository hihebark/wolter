import { AsyncLocalStorage } from 'node:async_hooks';

// A per-inbound-request id, propagated across the async call chain (route
// handler -> TypeORM query -> ...) so http/exception/query events that
// belong to the same request can be correlated into a waterfall. Established
// by WolterTraceMiddleware, which runs earliest in the request lifecycle —
// before guards/interceptors — so ALS context covers everything downstream.
const als = new AsyncLocalStorage<string>();

export const TraceContext = {
  run<T>(traceId: string, fn: () => T): T {
    return als.run(traceId, fn);
  },
  current(): string | undefined {
    return als.getStore();
  },
};
