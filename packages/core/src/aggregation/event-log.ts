import { WolterEvent } from '../interfaces/event.interface';
import { WolterStorageDriver } from '../interfaces/storage.interface';
import { parseRetentionMs } from './aggregator';
import { normalizeLabel } from './normalize-query';

// Raw per-occurrence storage, scoped to the categories the dashboard can
// actually show a useful detail view for. Jobs/Cache/Runtime stay
// aggregate-only — those are plugin categories, out of scope here. 'log'
// is here so WolterLoggerPlugin's trace-correlated log lines are queryable
// by /api/trace/:traceId alongside http/exception/query — that's the whole
// point of correlating them (see WolterLoggerPlugin).
const RAW_EVENT_CATEGORIES = new Set(['http', 'exception', 'query', 'log']);
const PRUNE_INTERVAL_MS = 5 * 60_000;

export class EventLog {
  private pruneTimer?: NodeJS.Timeout;
  private readonly retentionMs: number;

  constructor(
    private storage: WolterStorageDriver,
    retention?: string,
    private retentionCount = 500,
  ) {
    this.retentionMs = parseRetentionMs(retention);
  }

  start(): void {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  // ponytail: direct synchronous write per event, no flush buffer — better-sqlite3
  // inserts are fast enough at this tool's expected traffic scale. Add batching
  // if benchmarks ever show write contention under heavy load.
  record(event: WolterEvent): void {
    if (!RAW_EVENT_CATEGORIES.has(event.category)) return;
    const result = this.storage.writeEvent({
      category: event.category,
      label: normalizeLabel(event),
      status: event.status,
      statusCode: event.statusCode,
      duration: event.duration ?? 0,
      traceId: event.traceId,
      meta: event.meta ?? {},
      timestamp: event.timestamp,
    });
    // writeEvent may return a Promise (the interface allows it) — the
    // bundled SQLite driver doesn't, but any async driver (network DB,
    // remote sink) could reject after this call has already returned
    // synchronously. Not awaited (record() stays sync — this runs on every
    // captured event and must not add latency to it), but the rejection is
    // still handled here rather than left to become an unhandled promise
    // rejection that bypasses Recorder's try/catch entirely, which is
    // exactly the kind of failure the "zero-impact guarantee" promises
    // never happens.
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {});
    }
  }

  private prune(): void {
    const olderThan = Date.now() - this.retentionMs;
    for (const category of RAW_EVENT_CATEGORIES) {
      this.storage.pruneEvents(category, olderThan, this.retentionCount);
    }
  }
}
