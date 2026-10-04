import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from './event-log';
import { AggregatedBucket, RawEvent, RetentionInfo, WolterStorageDriver } from '../interfaces/storage.interface';

class FakeStorage implements WolterStorageDriver {
  written: RawEvent[] = [];
  pruned: Array<{ category: string; olderThan: number; keepCount: number }> = [];
  write(): void {}
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
  writeEvent(event: RawEvent): void {
    this.written.push(event);
  }
  queryEvents(): RawEvent[] {
    return [];
  }
  queryEventsByTrace(): RawEvent[] {
    return [];
  }
  pruneEvents(category: string, olderThan: number, keepCount: number): void {
    this.pruned.push({ category, olderThan, keepCount });
  }
}

test('record stores raw events for http/exception/query but skips other categories', () => {
  const storage = new FakeStorage();
  const eventLog = new EventLog(storage);
  const now = Date.now();

  eventLog.record({ plugin: 'core', category: 'http', label: 'GET /x', status: 'ok', timestamp: now });
  eventLog.record({ plugin: 'node', category: 'runtime', label: 'cpu', status: 'ok', timestamp: now });

  assert.equal(storage.written.length, 1);
  assert.equal(storage.written[0].category, 'http');
});

test('record normalizes query labels the same way the aggregator groups them', () => {
  const storage = new FakeStorage();
  const eventLog = new EventLog(storage);
  const now = Date.now();

  eventLog.record({ plugin: 'typeorm', category: 'query', label: 'SELECT * FROM t WHERE id = 1', status: 'ok', timestamp: now });

  assert.equal(storage.written[0].label, 'SELECT * FROM t WHERE id = ?');
});

test('record carries meta through untouched', () => {
  const storage = new FakeStorage();
  const eventLog = new EventLog(storage);
  const now = Date.now();

  eventLog.record({
    plugin: 'core',
    category: 'exception',
    label: 'NotFoundException',
    status: 'ok',
    meta: { message: 'not found', stack: 'Error: not found\n  at x' },
    timestamp: now,
  });

  assert.deepEqual(storage.written[0].meta, { message: 'not found', stack: 'Error: not found\n  at x' });
});

test('record() does not produce an unhandled rejection when writeEvent() returns a rejecting promise', async () => {
  class RejectingStorage extends FakeStorage {
    writeEvent(): Promise<void> {
      return Promise.reject(new Error('driver down'));
    }
  }
  const storage = new RejectingStorage();
  const eventLog = new EventLog(storage);

  let sawUnhandledRejection = false;
  const onUnhandled = () => {
    sawUnhandledRejection = true;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    // record() itself must stay synchronous and must not throw, even though
    // the driver's returned promise rejects — that rejection is handled
    // internally, not surfaced to the caller.
    eventLog.record({ plugin: 'core', category: 'http', label: 'GET /x', status: 'ok', timestamp: Date.now() });
    // Give the rejected promise's microtask a turn to (not) become unhandled.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(sawUnhandledRejection, false);
});

test('prune sweeps only the raw-event categories', () => {
  const storage = new FakeStorage();
  const eventLog = new EventLog(storage, undefined, 250);
  (eventLog as unknown as { prune(): void }).prune();

  const categories = storage.pruned.map((p) => p.category).sort();
  assert.deepEqual(categories, ['exception', 'http', 'log', 'query']);
  assert.ok(storage.pruned.every((p) => p.keepCount === 250));
});
