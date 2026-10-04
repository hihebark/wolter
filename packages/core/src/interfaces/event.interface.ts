export type EventCategory = 'query' | 'job' | 'cache' | 'http' | 'exception' | 'runtime' | 'log';
export type EventStatus = 'ok' | 'error' | 'slow';

export interface WolterEvent {
  plugin: string;
  category: EventCategory;
  label: string;
  duration?: number;
  status: EventStatus;
  /** HTTP response status code — set by the core HTTP watcher, used to bucket 1xx-3xx/4xx/5xx counts. */
  statusCode?: number;
  /** Correlates events from the same inbound request (http/exception/query only) — see TraceContext. */
  traceId?: string;
  /** Matched route identity (http only, set when req.route.path resolved) — lets the aggregator
   *  resolve a stable backend-owned route id instead of the dashboard parsing it out of `label`. */
  routeMethod?: string;
  routePath?: string;
  meta?: Record<string, unknown>;
  timestamp: number;
}
