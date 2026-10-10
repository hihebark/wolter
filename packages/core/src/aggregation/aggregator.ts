import { TDigest } from 'tdigest';
import { WolterEvent } from '../interfaces/event.interface';
import { AggregatedBucket, WolterStorageDriver } from '../interfaces/storage.interface';
import { normalizeLabel } from './normalize-query';
import { swallow } from '../swallow';

// ponytail: single 1-minute bucket resolution, no 5-min/1-hour rollup tiers.
// Fine up to ~24h retention; add coarser tiers only once retention needs to
// extend further and per-minute rows become too many to query cheaply.
const BUCKET_SIZE_MS = 60_000;
const FLUSH_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
// How long a closed window whose write keeps failing stays buffered for retry.
// Covers a transient error (SQLITE_BUSY, a network driver blip) without letting
// a storage that's down for good grow the buffer by one entry per label per minute.
const MAX_RETRY_AGE_MS = 5 * 60_000;
// Distinct labels one category may open per 1-minute window; the rest fold
// into OVERFLOW_LABEL. Labels can carry request-derived text (exception
// messages, cache keys, plugin labels), so without a hard cap an anonymous
// client sending unique values would set the number of buffer entries,
// metric rows and label rows. Generous for real apps — normalization already
// collapses ids/numbers, so legitimate distinct shapes per minute stay small.
const MAX_LABELS_PER_CATEGORY_WINDOW = 500;
export const OVERFLOW_LABEL = '(other)';
// Hitting the cap means a plugin emits request-derived labels or the app is
// being flooded — worth a console warning, but at most once per category per
// hour so a sustained flood can't turn the warning itself into log spam.
const OVERFLOW_WARN_INTERVAL_MS = 60 * 60_000;

/** A category that hit the per-window label cap — surfaced on /api/health. */
export interface LabelOverflow {
  category: string;
  /** Events folded into OVERFLOW_LABEL since startup. */
  folded: number;
  /** Last time an event was folded. */
  lastAt: number;
}
// Categories recorded only as raw events, never aggregated: 'log' labels are
// the raw log line (kept verbatim for the trace waterfall) and api/metrics
// never serves the category, so aggregating it would only add rows.
const UNAGGREGATED_CATEGORIES = new Set(['log']);

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
  /** Changed since its last successful write — flush() skips clean entries. */
  dirty: boolean;
  /** Latest event timestamp in this entry — an exception's "last seen" for its issue. */
  lastSeen: number;
}

export class Aggregator {
  private buffer = new Map<string, BufferEntry>();
  // windowStart -> category -> distinct labels opened in that window.
  private labelCounts = new Map<number, Map<string, number>>();
  private overflow = new Map<string, LabelOverflow & { warnedAt: number }>();
  private flushTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private readonly retentionMs: number;

  constructor(
    private storage: WolterStorageDriver,
    retention?: string,
    private readonly maxRowsPerCategory?: number,
  ) {
    this.retentionMs = parseRetentionMs(retention);
  }

  start(): void {
    this.flushTimer = setInterval(() => swallow(() => this.flush()), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();

    this.pruneTimer = setInterval(() => swallow(() => this.storage.prune(Date.now() - this.retentionMs, this.maxRowsPerCategory)), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await this.flush();
  }

  ingest(event: WolterEvent): void {
    if (UNAGGREGATED_CATEGORIES.has(event.category)) return;
    let label = normalizeLabel(event);
    const windowStart = Math.floor(event.timestamp / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
    let key = `${event.category}:${label}:${windowStart}`;

    let entry = this.buffer.get(key);
    if (!entry && !this.admitLabel(event.category, windowStart)) {
      this.noteOverflow(event.category, event.timestamp);
      label = OVERFLOW_LABEL;
      key = `${event.category}:${label}:${windowStart}`;
      entry = this.buffer.get(key);
    }
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
        dirty: true,
        lastSeen: event.timestamp,
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
    entry.lastSeen = Math.max(entry.lastSeen, event.timestamp);
    entry.dirty = true;
  }

  // Counts a new distinct label toward its category's per-window cap; false
  // once the cap is reached (the caller folds the event into OVERFLOW_LABEL).
  private admitLabel(category: string, windowStart: number): boolean {
    let perCategory = this.labelCounts.get(windowStart);
    if (!perCategory) {
      perCategory = new Map();
      this.labelCounts.set(windowStart, perCategory);
    }
    const count = perCategory.get(category) ?? 0;
    if (count >= MAX_LABELS_PER_CATEGORY_WINDOW) return false;
    perCategory.set(category, count + 1);
    return true;
  }

  /** Drops buffered (not yet flushed, or still-open) entries matching a data clear, so the
   *  next flush can't write cleared metrics back. Same matching as ClearFilter for metrics. */
  discard(filter: { category?: string; label?: string; since?: number; until?: number }): void {
    for (const [key, entry] of this.buffer.entries()) {
      if (filter.category !== undefined && entry.category !== filter.category) continue;
      if (filter.label !== undefined && entry.label !== filter.label) continue;
      if (filter.since !== undefined && entry.windowStart < filter.since) continue;
      if (filter.until !== undefined && entry.windowStart >= filter.until) continue;
      this.buffer.delete(key);
    }
  }

  overflowStatus(): LabelOverflow[] {
    return [...this.overflow.values()].map(({ category, folded, lastAt }) => ({ category, folded, lastAt }));
  }

  private noteOverflow(category: string, at: number): void {
    let o = this.overflow.get(category);
    if (!o) {
      o = { category, folded: 0, lastAt: at, warnedAt: -Infinity };
      this.overflow.set(category, o);
    }
    o.folded += 1;
    o.lastAt = at;
    if (at - o.warnedAt >= OVERFLOW_WARN_INTERVAL_MS) {
      o.warnedAt = at;
      // eslint-disable-next-line no-console
      console.warn(
        `[Wolter] More than ${MAX_LABELS_PER_CATEGORY_WINDOW} distinct '${category}' labels in one minute; ` +
          `the rest are grouped as '${OVERFLOW_LABEL}'. A plugin may be labelling events with request data, ` +
          'or the app is receiving unusual traffic.',
      );
    }
  }

  private async flush(): Promise<void> {
    const now = Date.now();
    const tooOld = (entry: BufferEntry) => now > entry.windowStart + BUCKET_SIZE_MS + MAX_RETRY_AGE_MS;

    // Phase 1: pick the changed entries and resolve their route/label ids.
    // Resolved once per entry, not once per flush — the entry (and its
    // routeId/labelId, once known) lives in the buffer until its window ages
    // out, so a hot route/label doesn't re-hit storage on every 5s tick.
    const batch: Array<[string, BufferEntry]> = [];
    for (const [key, entry] of this.buffer.entries()) {
      // Unchanged since its last write — rewriting it would be pure cost
      // (every write is a full upsert of the same values).
      if (!entry.dirty) {
        if (now > entry.windowStart + BUCKET_SIZE_MS) this.buffer.delete(key);
        continue;
      }
      try {
        if (entry.routeMethod && entry.routePath && entry.routeId === undefined) {
          entry.routeId = await this.storage.resolveRoute(entry.routeMethod, entry.routePath);
        } else if (!entry.routeMethod && entry.labelId === undefined) {
          entry.labelId = await this.storage.resolveLabel(entry.category, entry.label);
        }
      } catch {
        // Zero-impact guarantee. Left buffered (still dirty) so the next
        // cycle retries it, until it's too old to be worth keeping.
        if (tooOld(entry)) this.buffer.delete(key);
        continue;
      }
      // Issue tracking: separate try, so a failing issue update never holds
      // back the metric write. The overflow bucket isn't one bug, so no issue.
      if (entry.category === 'exception' && entry.label !== OVERFLOW_LABEL && this.storage.issues) {
        try {
          await this.storage.issues.touch(entry.label, entry.lastSeen);
        } catch {
          // Zero-impact guarantee. Retried on this entry's next change.
        }
      }
      batch.push([key, entry]);
    }

    // Phase 2: write. dirty is cleared before the write, not after —
    // ingest() is synchronous, but storage writes only have to be async (the
    // interface allows it; the bundled SQLite driver just happens to resolve
    // immediately), so an ingest() for one of these keys can land while the
    // write is in flight and set dirty again. That's how we notice it,
    // instead of deleting an entry that now holds increments nothing has
    // flushed yet.
    for (const [, entry] of batch) entry.dirty = false;
    if (batch.length === 0) {
      // Nothing changed this cycle — no write at all.
    } else if (this.storage.writeBatch) {
      try {
        await this.storage.writeBatch(batch.map(([, entry]) => this.toBucket(entry)));
      } catch {
        // All or nothing — every entry stays buffered for the next cycle.
        for (const [key, entry] of batch) {
          entry.dirty = true;
          if (tooOld(entry)) this.buffer.delete(key);
        }
      }
    } else {
      for (const [key, entry] of batch) {
        try {
          await this.storage.write(this.toBucket(entry));
        } catch {
          // One bad entry mustn't stop the rest of this flush (or stop()'s
          // final flush) from writing.
          entry.dirty = true;
          if (tooOld(entry)) this.buffer.delete(key);
        }
      }
    }

    // Window closed AND nothing ingested while the write was pending — safe
    // to drop. If it changed, leave it buffered; the next flush cycle picks
    // up the newer total (writes are a full upsert replace, so a
    // slightly-delayed final write is harmless — a deleted entry with
    // unflushed increments would not be).
    for (const [key, entry] of batch) {
      if (now > entry.windowStart + BUCKET_SIZE_MS && !entry.dirty) this.buffer.delete(key);
    }
    for (const windowStart of this.labelCounts.keys()) {
      if (now > windowStart + BUCKET_SIZE_MS) this.labelCounts.delete(windowStart);
    }
  }

  private toBucket(entry: BufferEntry): AggregatedBucket {
    entry.digest.compress();
    return {
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
    };
  }
}
