export interface AggregatedBucket {
  category: string;
  label: string;
  window: number;
  count: number;
  errorCount: number;
  /** status === 'slow', any category */
  slowCount: number;
  /** HTTP-only: response status code buckets. 0 for non-http categories. */
  normalCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  totalDuration: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  timestamp: number;
  /** HTTP-only, matched routes only: id of the resolved row in the routes table (see resolveRoute). */
  routeId?: number;
  /** HTTP-only, matched routes only: populated by query() via a join against the routes table —
   *  never set on a bucket passed to write(). Lets the dashboard show method/path without parsing `label`. */
  method?: string;
  path?: string;
  /** Every other category (query/exception/job/cache/runtime): id of the resolved row in the
   *  labels table (see resolveLabel) — the same backend-owned-identity idea as routeId, just without
   *  a method/path split since these labels are already a single flat grouping string. */
  labelId?: number;
}

// A single raw occurrence — kept separately from AggregatedBucket so the
// dashboard can show an actual request/exception/query, not just its trend.
export interface RawEvent {
  id?: number;
  category: string;
  label: string;
  status: string;
  statusCode?: number;
  duration: number;
  /** Correlates events from the same inbound request — see TraceContext. */
  traceId?: string;
  meta: Record<string, unknown>;
  timestamp: number;
}

// Surfaced on /api/health next to the storage.retention option — lets the
// dashboard show how far back data actually goes today, not just what the
// configured retention *would* keep.
export interface RetentionInfo {
  /** Oldest raw event (request/exception/query occurrence) still stored, or null if none captured yet. */
  oldestEventTs: number | null;
  /** Oldest aggregated metric bucket still stored, or null if none captured yet. */
  oldestMetricTs: number | null;
}

export interface WolterStorageDriver {
  write(bucket: AggregatedBucket): void | Promise<void>;
  /** Get-or-create a route's id by (method, path) — the backend-owned identity for a matched HTTP
   *  route. Only called for routes that were actually hit, never pre-registered from the router. */
  resolveRoute(method: string, path: string): number | Promise<number>;
  /** Get-or-create a (category, label)'s id — the same backend-owned identity as resolveRoute,
   *  generalized to every non-http category (query/exception/job/cache/runtime). */
  resolveLabel(category: string, label: string): number | Promise<number>;
  query(category: string, range: string, search?: string): AggregatedBucket[] | Promise<AggregatedBucket[]>;
  prune(olderThan: number): void | Promise<void>;
  health(): boolean | Promise<boolean>;
  retentionInfo(): RetentionInfo | Promise<RetentionInfo>;
  /** Called once on application shutdown so a driver can release its
   *  connection/file handle explicitly rather than relying on process exit
   *  to reclaim it (WAL checkpoint, open fds, ...). Optional — a driver with
   *  nothing to clean up can simply omit it. */
  close?(): void | Promise<void>;
  writeEvent(event: RawEvent): void | Promise<void>;
  queryEvents(category: string, label: string, range: string, limit: number): RawEvent[] | Promise<RawEvent[]>;
  /** All raw events sharing a traceId, across every category, oldest first — the waterfall view's data source. */
  queryEventsByTrace(traceId: string, limit: number): RawEvent[] | Promise<RawEvent[]>;
  pruneEvents(category: string, olderThan: number, keepCount: number): void | Promise<void>;
}
