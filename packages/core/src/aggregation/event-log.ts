import { WolterEvent } from '../interfaces/event.interface';
import { WolterStorageDriver } from '../interfaces/storage.interface';
import { parseRetentionMs } from './aggregator';
import { normalizeLabel } from './normalize-query';
import { swallow } from '../swallow';

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
    // writeEvent may return a Promise (the interface allows it) — not awaited
    // (record() runs on every captured event and must not add latency), but
    // a rejection is still handled rather than left to become an unhandled
    // rejection that bypasses Recorder's try/catch entirely.
    swallow(() =>
      this.storage.writeEvent({
        category: event.category,
        label: normalizeLabel(event),
        status: event.status,
        statusCode: event.statusCode,
        duration: event.duration ?? 0,
        traceId: event.traceId,
        meta: event.meta ?? {},
        timestamp: event.timestamp,
      }),
    );
  }

  private prune(): void {
    const olderThan = Date.now() - this.retentionMs;
    for (const category of RAW_EVENT_CATEGORIES) {
      // Runs from a timer, outside Recorder's try/catch — a throw here would be uncaught.
      swallow(() => this.storage.pruneEvents(category, olderThan, this.retentionCount));
    }
  }
}
