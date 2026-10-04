import { TDigest } from 'tdigest';
import { WolterEvent } from '../interfaces/event.interface';
import { WolterStorageDriver } from '../interfaces/storage.interface';
import { normalizeLabel } from './normalize-query';

// ponytail: single 1-minute bucket resolution, no 5-min/1-hour rollup tiers.
// Fine up to ~24h retention; add coarser tiers only once retention needs to
// extend further and per-minute rows become too many to query cheaply.
const BUCKET_SIZE_MS = 60_000;
const FLUSH_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;

// ponytail: covers the "Nh"/"Nd"/"Nm" strings the spec's config examples use
// (e.g. '24h', '7d') — not a full duration-string parser. Falls back to 24h
// on anything else, matching the documented default retention.
export function parseRetentionMs(retention: string | undefined): number {
  const match = /^(\d+)(m|h|d)$/.exec(retention ?? '');
  if (!match) return 24 * 60 * 60_000;
  const unitMs = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unitMs;
}

interface BufferEntry {
  category: string;
  label: string;
  windowStart: number;
  count: number;
  errorCount: number;
  slowCount: number;
  normalCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  totalDuration: number;
  min: number;
  max: number;
  digest: TDigest;
  routeMethod?: string;
  routePath?: string;
  routeId?: number;
  labelId?: number;
}

export class Aggregator {
  private buffer = new Map<string, BufferEntry>();
  private flushTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private readonly retentionMs: number;

  constructor(private storage: WolterStorageDriver, retention?: string) {
    this.retentionMs = parseRetentionMs(retention);
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();

    this.pruneTimer = setInterval(() => this.storage.prune(Date.now() - this.retentionMs), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await this.flush();
  }

  ingest(event: WolterEvent): void {
    const label = normalizeLabel(event);
    const windowStart = Math.floor(event.timestamp / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
    const key = `${event.category}:${label}:${windowStart}`;

    let entry = this.buffer.get(key);
    if (!entry) {
      entry = {
        category: event.category,
        label,
        windowStart,
        count: 0,
        errorCount: 0,
        slowCount: 0,
        normalCount: 0,
        clientErrorCount: 0,
        serverErrorCount: 0,
        totalDuration: 0,
        min: Infinity,
        max: -Infinity,
        digest: new TDigest(),
      };
      this.buffer.set(key, entry);
    }

    if (event.routeMethod && event.routePath) {
      entry.routeMethod = event.routeMethod;
      entry.routePath = event.routePath;
    }
    entry.count += 1;
    if (event.status === 'error') entry.errorCount += 1;
    if (event.status === 'slow') entry.slowCount += 1;
    if (event.category === 'http' && event.statusCode !== undefined) {
      if (event.statusCode >= 500) entry.serverErrorCount += 1;
      else if (event.statusCode >= 400) entry.clientErrorCount += 1;
      else entry.normalCount += 1;
    }
    const duration = event.duration ?? 0;
    entry.totalDuration += duration;
    entry.min = Math.min(entry.min, duration);
    entry.max = Math.max(entry.max, duration);
    entry.digest.push(duration);
  }

  private async flush(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.buffer.entries()) {
      // Snapshotted before the write below — ingest() is synchronous, but
      // storage.write() only has to be async (the interface allows it; the
      // bundled SQLite driver just happens to resolve immediately), so an
      // ingest() for this same key can land while the write is in flight.
      // Comparing against this after the await is how we notice that
      // happened, instead of deleting an entry that now holds increments
      // nothing has flushed yet.
      const countAtSnapshot = entry.count;
      entry.digest.compress();
      // Resolved once per entry, not once per flush — the entry (and its
      // routeId/labelId, once known) lives in the buffer until its window
      // ages out, so a hot route/label doesn't re-hit storage on every 5s tick.
      if (entry.routeMethod && entry.routePath && entry.routeId === undefined) {
        entry.routeId = await this.storage.resolveRoute(entry.routeMethod, entry.routePath);
      } else if (!entry.routeMethod && entry.labelId === undefined) {
        entry.labelId = await this.storage.resolveLabel(entry.category, entry.label);
      }
      await this.storage.write({
        category: entry.category,
        label: entry.label,
        window: entry.windowStart,
        count: entry.count,
        errorCount: entry.errorCount,
        slowCount: entry.slowCount,
        normalCount: entry.normalCount,
        clientErrorCount: entry.clientErrorCount,
        serverErrorCount: entry.serverErrorCount,
        totalDuration: entry.totalDuration,
        min: entry.min === Infinity ? 0 : entry.min,
        max: entry.max === -Infinity ? 0 : entry.max,
        p50: entry.digest.percentile(0.5) || 0,
        p95: entry.digest.percentile(0.95) || 0,
        p99: entry.digest.percentile(0.99) || 0,
        timestamp: entry.windowStart,
        routeId: entry.routeId,
        labelId: entry.labelId,
      });

      // Window closed AND nothing ingested while the write above was
      // pending — safe to drop. If count moved, leave it buffered; the next
      // flush cycle picks up the newer total (write() is a full upsert
      // replace, so a slightly-delayed final write is harmless — a deleted
      // entry with unflushed increments would not be).
      if (now > entry.windowStart + BUCKET_SIZE_MS && entry.count === countAtSnapshot) {
        this.buffer.delete(key);
      }
    }
  }
}
