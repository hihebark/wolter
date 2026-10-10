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

export type IssueStatus = 'open' | 'resolved' | 'ignored';
export type IssuePriority = 'low' | 'medium' | 'high' | 'critical';

/** A tracked exception group. `fingerprint` is the exception label (class + throw site, see
 *  normalizeLabel), so one issue is one group on the Exceptions page. */
export interface Issue {
  id: number;
  fingerprint: string;
  status: IssueStatus;
  priority: IssuePriority | null;
  assignee: string | null;
  firstSeen: number;
  lastSeen: number;
  /** When it was last marked resolved; null unless status is 'resolved'. */
  resolvedAt: number | null;
  updatedAt: number;
}

export interface IssueComment {
  id: number;
  issueId: number;
  author: string;
  body: string;
  createdAt: number;
}

export interface IssueUpdate {
  status?: IssueStatus;
  priority?: IssuePriority | null;
  assignee?: string | null;
}

/** Issue tracking on top of exception groups. Optional on WolterStorageDriver: a driver
 *  without it simply has no issue features (the issue API answers 501). */
export interface IssueStore {
  /** Record that a group occurred at `seenAt`: creates its issue (open) on first sight,
   *  advances lastSeen, and reopens a resolved issue when `seenAt` is after its resolvedAt
   *  (adding an automatic comment saying so). Ignored issues stay ignored. */
  touch(fingerprint: string, seenAt: number): void | Promise<void>;
  list(status?: IssueStatus): Issue[] | Promise<Issue[]>;
  get(id: number): (Issue & { comments: IssueComment[] }) | undefined | Promise<(Issue & { comments: IssueComment[] }) | undefined>;
  update(id: number, update: IssueUpdate, now: number): Issue | undefined | Promise<Issue | undefined>;
  addComment(id: number, author: string, body: string, now: number): IssueComment | undefined | Promise<IssueComment | undefined>;
}

/** What to delete in clearData. Every given field narrows the match; omitted fields match all. */
export interface ClearFilter {
  /** Which stored data: aggregated metric buckets and/or raw per-occurrence events. */
  tables: Array<'metrics' | 'events'>;
  category?: string;
  /** Exact group label, e.g. 'GET /users/:id' or an exception fingerprint. */
  label?: string;
  /** Inclusive lower / exclusive upper bound on the row timestamp (ms). */
  since?: number;
  until?: number;
  /** HTTP status code — raw events only (metric buckets don't keep per-request codes). */
  statusCode?: number;
}

export interface ClearResult {
  metrics: number;
  events: number;
}

export interface WolterStorageDriver {
  /** Optional issue tracking — see IssueStore. */
  issues?: IssueStore;
  /** Optional: delete (or, with dryRun, only count) the rows matching `filter`, all in one unit.
   *  Never touches issues. Without it, the dashboard's Data page answers 501. */
  clearData?(filter: ClearFilter, dryRun: boolean): ClearResult | Promise<ClearResult>;
  write(bucket: AggregatedBucket): void | Promise<void>;
  /** Optional: write every bucket of one flush cycle as a single unit (one transaction), all or
   *  nothing. When absent, the aggregator falls back to one write() per bucket. */
  writeBatch?(buckets: AggregatedBucket[]): void | Promise<void>;
  /** Get-or-create a route's id by (method, path) — the backend-owned identity for a matched HTTP
   *  route. Only called for routes that were actually hit, never pre-registered from the router. */
  resolveRoute(method: string, path: string): number | Promise<number>;
  /** Get-or-create a (category, label)'s id — the same backend-owned identity as resolveRoute,
   *  generalized to every non-http category (query/exception/job/cache/runtime). */
  resolveLabel(category: string, label: string): number | Promise<number>;
  query(category: string, range: string, search?: string): AggregatedBucket[] | Promise<AggregatedBucket[]>;
  /** Delete metric buckets older than `olderThan`, then — when `maxRowsPerCategory` is given —
   *  the oldest buckets beyond that many per category, so stored size stays bounded even when
   *  traffic (or an attacker) produces more distinct labels than retention alone would cap. */
  prune(olderThan: number, maxRowsPerCategory?: number): void | Promise<void>;
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
