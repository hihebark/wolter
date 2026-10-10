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
  // Resolves once write() has actually been entered — the second ingest()
  // below must land while the write is in flight, not before it starts
  // (an ingest before the write is simply included in it).
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });
  const written: AggregatedBucket[] = [];
  class SlowStorage implements WolterStorageDriver {
    async write(bucket: AggregatedBucket): Promise<void> {
      written.push(bucket);
      markWriteStarted();
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
  await writeStarted;
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

// Regression: flush()/prune() run from setInterval, outside Recorder's
// try/catch — a storage throw there used to reject unhandled (flush) or throw
// uncaught (prune), which crashes the host process on Node >= 15.
test('a throwing storage never escapes stop(), and the other buckets still get written', async () => {
  const storage = new FakeStorage();
  const write = storage.write.bind(storage);
  storage.write = (bucket) => {
    if (bucket.label === 'GET /bad') throw new Error('SQLITE_FULL');
    write(bucket);
  };
  const aggregator = new Aggregator(storage);
  const now = Date.now();
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /bad', duration: 1, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /good', duration: 1, status: 'ok', timestamp: now });

  await aggregator.stop();

  assert.deepEqual(storage.written.map((b) => b.label), ['GET /good']);
});

test('a failed write stays buffered and is retried on the next flush', async () => {
  const storage = new FakeStorage();
  const write = storage.write.bind(storage);
  let fail = true;
  storage.write = (bucket) => {
    if (fail) throw new Error('SQLITE_BUSY');
    write(bucket);
  };
  const aggregator = new Aggregator(storage);
  const flush = () => (aggregator as unknown as { flush(): Promise<void> }).flush();
  // A closed window — a successful write would drop it from the buffer.
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'ok', timestamp: Date.now() - 120_000 });

  await flush();
  fail = false;
  await flush();

  assert.equal(storage.written.length, 1);
});

test('timer-driven flush/prune failures do not surface as unhandled rejections or uncaught exceptions', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const storage = new FakeStorage();
  storage.write = () => Promise.reject(new Error('driver down')) as unknown as void;
  storage.prune = () => {
    throw new Error('SQLITE_IOERR');
  };
  let escaped = false;
  const onEscape = () => (escaped = true);
  process.on('unhandledRejection', onEscape);
  process.on('uncaughtException', onEscape);
  try {
    const aggregator = new Aggregator(storage);
    aggregator.start();
    aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'ok', timestamp: Date.now() });
    // Throws synchronously out of tick() if the prune callback isn't guarded.
    t.mock.timers.tick(5 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    await aggregator.stop();
  } finally {
    process.off('unhandledRejection', onEscape);
    process.off('uncaughtException', onEscape);
  }
  assert.equal(escaped, false);
});

// Regression for unbounded label cardinality: request-derived labels
// (exception messages, cache keys, plugin labels) used to create one buffer
// entry, metric row and label row per distinct value, with no limit.
test('log events are never aggregated (they are raw-event only)', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  aggregator.ingest({ plugin: 'logger', category: 'log', label: 'Fetched product 1a2b3c4d5e6f', status: 'ok', timestamp: Date.now() });
  await aggregator.stop();
  assert.equal(storage.written.length, 0);
  assert.equal(storage.labelIds.size, 0);
});

test('distinct labels per category per window are capped; the rest fold into (other)', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();
  for (let i = 0; i < 2000; i++) {
    // A plugin that emits a distinct label per event — core only length-caps
    // emitter-set labels, so only the per-window cap bounds these.
    aggregator.ingest({ plugin: 'misbehaving', category: 'job', label: 'queue-' + i, status: 'ok', timestamp: now });
  }
  await aggregator.stop();

  assert.equal(storage.written.length, 501); // 500 distinct + one overflow bucket
  const overflow = storage.written.find((b) => b.label === '(other)');
  assert.equal(overflow?.count, 1500);
  assert.equal(storage.written.reduce((sum, b) => sum + b.count, 0), 2000); // nothing dropped
});

test('flush() skips entries that have not changed since their last write', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const flush = () => (aggregator as unknown as { flush(): Promise<void> }).flush();
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 1, status: 'ok', timestamp: Date.now() });

  await flush();
  await flush();
  assert.equal(storage.written.length, 1);

  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', duration: 2, status: 'ok', timestamp: Date.now() });
  await flush();
  assert.equal(storage.written.length, 2);
  assert.equal(storage.written[1].count, 2);
});

test('flush() sends all changed buckets in one writeBatch() call when the driver supports it', async () => {
  const storage = new FakeStorage();
  const batches: AggregatedBucket[][] = [];
  (storage as WolterStorageDriver).writeBatch = (buckets) => {
    batches.push(buckets);
  };
  const aggregator = new Aggregator(storage);
  const now = Date.now();
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /a', duration: 1, status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /b', duration: 1, status: 'ok', timestamp: now });
  await aggregator.stop();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((b) => b.label).sort(), ['GET /a', 'GET /b']);
  assert.equal(storage.written.length, 0); // per-bucket write() not used
});

test('a failed writeBatch() keeps every entry buffered and retries the whole batch', async () => {
  const storage = new FakeStorage();
  let fail = true;
  const batches: AggregatedBucket[][] = [];
  (storage as WolterStorageDriver).writeBatch = (buckets) => {
    if (fail) throw new Error('SQLITE_BUSY');
    batches.push(buckets);
  };
  const aggregator = new Aggregator(storage);
  const flush = () => (aggregator as unknown as { flush(): Promise<void> }).flush();
  const closed = Date.now() - 120_000; // a successful write would drop these from the buffer
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /a', duration: 1, status: 'ok', timestamp: closed });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /b', duration: 1, status: 'ok', timestamp: closed });

  await flush();
  fail = false;
  await flush();
  await flush(); // nothing left to write

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test('the prune timer passes the per-category size cap through to storage.prune()', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const storage = new FakeStorage();
  const calls: Array<[number, number | undefined]> = [];
  (storage as WolterStorageDriver).prune = (olderThan, max) => {
    calls.push([olderThan, max]);
  };
  const aggregator = new Aggregator(storage, '24h', 1234);
  aggregator.start();
  t.mock.timers.tick(5 * 60_000);
  void aggregator.stop();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 1234);
});

test('hitting the label cap is recorded for /api/health and warned about at most once per category per hour', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (msg: string) => warnings.push(msg));
  const aggregator = new Aggregator(new FakeStorage());
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    aggregator.ingest({ plugin: 'misbehaving', category: 'job', label: 'queue-' + i, status: 'ok', timestamp: now });
  }
  // Same hour, next minute: still capped, but no second warning.
  for (let i = 0; i < 600; i++) {
    aggregator.ingest({ plugin: 'misbehaving', category: 'job', label: 'queue-' + i, status: 'ok', timestamp: now + 60_000 });
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /'job' labels/);
  assert.deepEqual(aggregator.overflowStatus(), [{ category: 'job', folded: 200, lastAt: now + 60_000 }]);
  await aggregator.stop();
});

test('no overflow is reported while under the cap', async () => {
  const aggregator = new Aggregator(new FakeStorage());
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', status: 'ok', timestamp: Date.now() });
  assert.deepEqual(aggregator.overflowStatus(), []);
  await aggregator.stop();
});

test('flush() touches an issue for each changed exception group, never for (other) or other categories', async () => {
  const storage = new FakeStorage();
  const touched: Array<[string, number]> = [];
  (storage as WolterStorageDriver).issues = {
    touch: (fingerprint, seenAt) => { touched.push([fingerprint, seenAt]); },
    list: () => [], get: () => undefined, update: () => undefined, addComment: () => undefined,
  };
  const aggregator = new Aggregator(storage);
  const now = Date.now();
  aggregator.ingest({ plugin: 'core', category: 'exception', label: 'TypeError', status: 'error', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'exception', label: 'TypeError', status: 'error', timestamp: now + 10 });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /x', status: 'ok', timestamp: now });
  for (let i = 0; i < 501; i++) {
    // Folded into (other) past the cap — must not become an issue.
    aggregator.ingest({ plugin: 'core', category: 'exception', label: 'E' + i, status: 'error', timestamp: now });
  }
  await aggregator.stop();

  assert.ok(touched.some(([fp, at]) => fp === 'TypeError' && at === now + 10)); // latest occurrence
  assert.ok(!touched.some(([fp]) => fp === '(other)' || fp === 'GET /x'));
});

test('a failing issue store never blocks the metric write', async () => {
  const storage = new FakeStorage();
  (storage as WolterStorageDriver).issues = {
    touch: () => { throw new Error('issues table locked'); },
    list: () => [], get: () => undefined, update: () => undefined, addComment: () => undefined,
  };
  const aggregator = new Aggregator(storage);
  aggregator.ingest({ plugin: 'core', category: 'exception', label: 'TypeError', status: 'error', timestamp: Date.now() });
  await aggregator.stop();
  assert.equal(storage.written.length, 1);
});

test('discard() drops matching buffered entries so a flush cannot write cleared metrics back', async () => {
  const storage = new FakeStorage();
  const aggregator = new Aggregator(storage);
  const now = Date.now();
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /a', status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'http', label: 'GET /b', status: 'ok', timestamp: now });
  aggregator.ingest({ plugin: 'core', category: 'query', label: 'SELECT 1', status: 'ok', timestamp: now });
  aggregator.discard({ category: 'http', label: 'GET /a' });
  await aggregator.stop();
  assert.deepEqual(storage.written.map((b) => b.label).sort(), ['GET /b', 'SELECT ?']); // query labels are normalized
});
