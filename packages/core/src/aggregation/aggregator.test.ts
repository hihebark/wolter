import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aggregator, parseRetentionMs } from './aggregator';
import { AggregatedBucket, RawEvent, RetentionInfo, WolterStorageDriver } from '../interfaces/storage.interface';

class FakeStorage implements WolterStorageDriver {
  written: AggregatedBucket[] = [];
  routeIds = new Map<string, number>();
  labelIds = new Map<string, number>();
  write(bucket: AggregatedBucket): void {
    this.written.push(bucket);
  }
  query(): AggregatedBucket[] {
    return [];
  }
  resolveRoute(method: string, path: string): number {
    const key = `${method} ${path}`;
    if (!this.routeIds.has(key)) this.routeIds.set(key, this.routeIds.size + 1);
    return this.routeIds.get(key)!;
  }
  resolveLabel(category: string, label: string): number {
    const key = `${category}:${label}`;
    if (!this.labelIds.has(key)) this.labelIds.set(key, this.labelIds.size + 1);
    return this.labelIds.get(key)!;
  }
  prune(): void {}
  health(): boolean {
    return true;
  }
  retentionInfo(): RetentionInfo {
    return { oldestEventTs: null, oldestMetricTs: null };
  }
  writeEvent(): void {}
  queryEvents(): RawEvent[] {
    return [];
  }
  queryEventsByTrace(): RawEvent[] {
    return [];
  }
  pruneEvents(): void {}
}

test('ingest aggregates count, errors, min/max per category+label+window', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();

  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 10, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 20, status: 'error', timestamp: now });
  await aggregator.stop();

  const bucket = storage.written.find((b) => b.label === 'GET /x');
  assert.ok(bucket);
  assert.equal(bucket!.count, 2);
  assert.equal(bucket!.errorCount, 1);
  assert.equal(bucket!.min, 10);
  assert.equal(bucket!.max, 20);
});

test('query events are grouped by normalized shape, not raw literal value', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();

  aggregator.ingest({
    plugin: 'typeorm',
    category: 'query',
    label: 'SELECT * FROM t WHERE id = 1',
    duration: 5,
    status: 'ok',
    timestamp: now,
  });
  aggregator.ingest({
    plugin: 'typeorm',
    category: 'query',
    label: 'SELECT * FROM t WHERE id = 2',
    duration: 5,
    status: 'ok',
    timestamp: now,
  });
  await aggregator.stop();

  const rows = storage.written.filter((b) => b.category === 'query');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

test('http status codes are classified into normal/client-error/server-error buckets', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();

  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'ok', statusCode: 200, timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'ok', statusCode: 301, timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'error', statusCode: 404, timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'error', statusCode: 500, timestamp: now });
  await aggregator.stop();

  const bucket = storage.written.find((b) => b.label === 'GET /x');
  assert.ok(bucket);
  assert.equal(bucket!.normalCount, 2);
  assert.equal(bucket!.clientErrorCount, 1);
  assert.equal(bucket!.serverErrorCount, 1);
});

test('a matched http route resolves routeId; every other bucket resolves labelId instead', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();

  aggregator.ingest({
    plugin: 'core', category: 'http', label: 'GET /users/:id', routeMethod: 'GET', routePath: '/users/:id',
    duration: 1, status: 'ok', timestamp: now,
  });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET (unmatched)', duration: 1, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'typeorm', category: 'query', label: 'SELECT 1', duration: 1, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'exception', label: 'NotFoundException', duration: 0, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'bullmq', category: 'job', label: 'emails', duration: 1, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'cache', category: 'cache', label: 'user:*', duration: 0, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'node', category: 'runtime', label: 'cpu', duration: 0, status: 'ok', timestamp: now });
  await aggregator.stop();

  const matched = storage.written.find((b) => b.label === 'GET /users/:id');
  const unmatched = storage.written.find((b) => b.label === 'GET (unmatched)');
  const query = storage.written.find((b) => b.category === 'query');
  const exception = storage.written.find((b) => b.category === 'exception');
  const job = storage.written.find((b) => b.category === 'job');
  const cache = storage.written.find((b) => b.category === 'cache');
  const runtime = storage.written.find((b) => b.category === 'runtime');

  assert.equal(matched!.routeId, storage.resolveRoute('GET', '/users/:id'));
  assert.equal(matched!.labelId, undefined);

  for (const bucket of [unmatched, query, exception, job, cache, runtime]) {
    assert.equal(bucket!.routeId, undefined);
    assert.equal(bucket!.labelId, storage.resolveLabel(bucket!.category, bucket!.label));
  }
});

test('non-http categories never populate the http status-code buckets', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();

  aggregator.ingest({ plugin: 'typeorm', category: 'query', label: 'SELECT 1', duration: 1, status: 'ok', timestamp: now });
  await aggregator.stop();

  const bucket = storage.written.find((b) => b.category === 'query');
  assert.ok(bucket);
  assert.equal(bucket!.normalCount, 0);
  assert.equal(bucket!.clientErrorCount, 0);
  assert.equal(bucket!.serverErrorCount, 0);
});

test('flush() does not drop an entry that received a concurrent ingest() while its write was pending', async () => {
  // Only the SQLite driver ships today, and it's synchronous — but the
  // interface allows write() to return a Promise, and any real async driver
  // (network DB, remote sink) would yield control right where this one
  // deliberately does, via the held-open `pendingWrite` promise.
  let resolveWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const written: AggregatedBucket[] = [];
  class SlowStorage implements WolterStorageDriver {
    async write(bucket: AggregatedBucket): Promise<void> {
      written.push(bucket);
      await pendingWrite;
    }
    query(): AggregatedBucket[] {
      return [];
    }
    resolveRoute(): number {
      return 1;
    }
    resolveLabel(): number {
      return 1;
    }
    prune(): void {}
    health(): boolean {
      return true;
    }
    retentionInfo(): RetentionInfo {
      return { oldestEventTs: null, oldestMetricTs: null };
    }
    writeEvent(): void {}
    queryEvents(): RawEvent[] {
      return [];
    }
    queryEventsByTrace(): RawEvent[] {
      return [];
    }
    pruneEvents(): void {}
  }

  const storage = new SlowStorage();
  const aggregator = new Aggregator(storage);
  // A window that's already closed, so flush()'s delete-check fires as soon
  // as the pending write resolves — the exact moment the bug would drop it.
  const windowStart = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
  const closedTimestamp = windowStart + 1_000;

  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 10, status: 'ok', timestamp: closedTimestamp });

  const flushPromise = (aggregator as unknown as { flush(): Promise<void> }).flush();
  // Lands while the write above is still in flight.
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 30, status: 'ok', timestamp: closedTimestamp });
  resolveWrite();
  await flushPromise;

  // Must still be buffered — deleting here would discard the second event,
  // which the write already in flight never included.
  const buffer = (aggregator as unknown as { buffer: Map<string, { count: number }> }).buffer;
  assert.equal(buffer.size, 1);

  // The next flush cycle picks up the full, correct total.
  await aggregator.stop();
  const last = written[written.length - 1];
  assert.equal(last.count, 2);
  assert.equal(last.totalDuration, 40);
});

test('parseRetentionMs handles m/h/d suffixes and falls back to 24h', () => {
  assert.equal(parseRetentionMs('30m'), 30 * 60_000);
  assert.equal(parseRetentionMs('24h'), 24 * 60 * 60_000);
  assert.equal(parseRetentionMs('7d'), 7 * 24 * 60 * 60_000);
  assert.equal(parseRetentionMs('garbage'), 24 * 60 * 60_000);
  assert.equal(parseRetentionMs(undefined), 24 * 60 * 60_000);
});
