import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, CanActivate } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createDashboardController } from './dashboard.controller';
import { AggregatedBucket, RawEvent, RetentionInfo, WolterStorageDriver } from '../interfaces/storage.interface';
import { PluginRegistry, PluginStatus } from '../plugin-registry';
import { SqliteStorage } from '../storage/sqlite.storage';
import { Aggregator, LabelOverflow } from '../aggregation/aggregator';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

class TestGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

// createDashboardController returns a plain class — no Nest bootstrap
// needed to exercise its methods, just construct it with a fake storage the
// same way the framework's own DI would inject the real one.
class FakeStorage implements WolterStorageDriver {
  queried: Array<{ category: string; range: string; search?: string }> = [];
  queriedEvents: Array<{ category: string; label: string; range: string; limit: number }> = [];
  write(): void {}
  query(category: string, range: string, search?: string): AggregatedBucket[] {
    this.queried.push({ category, range, search });
    return [{ category } as AggregatedBucket];
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
  queryEvents(category: string, label: string, range: string, limit: number): RawEvent[] {
    this.queriedEvents.push({ category, label, range, limit });
    return [{ category } as RawEvent];
  }
  queryEventsByTrace(): RawEvent[] {
    return [];
  }
  pruneEvents(): void {}
}

function makeController(storage: WolterStorageDriver, pluginRegistry?: PluginRegistry, aggregator?: Aggregator) {
  const Controller = createDashboardController('wolter', ['http']);
  return new (Controller as unknown as new (s: WolterStorageDriver, p: PluginRegistry, a: Aggregator) => {
    metrics(category: string, range?: string, search?: string): unknown;
    events(category: string, label: string, range?: string): unknown;
    health(): Promise<{ plugins: PluginStatus[]; sqliteInProduction: boolean; labelOverflow: LabelOverflow[] }>;
  })(
    storage,
    pluginRegistry ?? ({ status: () => [] } as unknown as PluginRegistry),
    aggregator ?? ({ overflowStatus: () => [] } as unknown as Aggregator),
  );
}

test('metrics() delegates to storage.query() with the given category', () => {
  const storage = new FakeStorage();
  const controller = makeController(storage);
  const result = controller.metrics('http', '1h', 'GET') as AggregatedBucket[];
  assert.deepEqual(storage.queried, [{ category: 'http', range: '1h', search: 'GET' }]);
  assert.equal(result[0].category, 'http');
});

test('metrics() rejects an unrecognized category instead of querying with it', () => {
  const storage = new FakeStorage();
  const controller = makeController(storage);
  assert.throws(() => controller.metrics('not-a-real-category', '1h'), BadRequestException);
  assert.equal(storage.queried.length, 0);
});

test('events() delegates to storage.queryEvents() with the given category and label', () => {
  const storage = new FakeStorage();
  const controller = makeController(storage);
  controller.events('exception', 'NotFoundException', '1h');
  assert.deepEqual(storage.queriedEvents, [{ category: 'exception', label: 'NotFoundException', range: '1h', limit: 50 }]);
});

test('events() rejects a category with no raw-event capture (e.g. jobs/cache/runtime)', () => {
  const storage = new FakeStorage();
  const controller = makeController(storage);
  assert.throws(() => controller.events('job', 'some-queue', '1h'), BadRequestException);
  assert.equal(storage.queriedEvents.length, 0);
});

test('health() includes plugin registration status from the plugin registry', async () => {
  const storage = new FakeStorage();
  const status: PluginStatus[] = [
    { name: 'typeorm', category: 'query', active: true },
    { name: 'broken-plugin', category: 'job', active: false, error: 'boom' },
  ];
  const pluginRegistry = { status: () => status } as unknown as PluginRegistry;
  const controller = makeController(storage, pluginRegistry);
  const health = await controller.health();
  assert.deepEqual(health.plugins, status);
});

test('events() accepts the log category (raw-captured for trace correlation)', () => {
  const storage = new FakeStorage();
  const controller = makeController(storage);
  controller.events('log', 'Fetching user', '1h');
  assert.deepEqual(storage.queriedEvents, [{ category: 'log', label: 'Fetching user', range: '1h', limit: 50 }]);
});

// Regression: the flag used to be just NODE_ENV === 'production', so it warned
// about SQLite even when a custom driver — the documented fix — was in use.
test('health() only flags sqliteInProduction when the storage really is SqliteStorage', async () => {
  const previous = process.env.NODE_ENV;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wolter-health-'));
  const sqlite = new SqliteStorage(path.join(dir, 'wolter.db'));
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await makeController(new FakeStorage()).health()).sqliteInProduction, false);
    assert.equal((await makeController(sqlite).health()).sqliteInProduction, true);
  } finally {
    process.env.NODE_ENV = previous;
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health() reports categories that hit the label cap', async () => {
  const overflow: LabelOverflow[] = [{ category: 'job', folded: 42, lastAt: 1 }];
  const controller = makeController(new FakeStorage(), undefined, { overflowStatus: () => overflow } as unknown as Aggregator);
  assert.deepEqual((await controller.health()).labelOverflow, overflow);
});

test('mounts at the configured path', () => {
  const controller = createDashboardController('metrics', ['http', 'exception']);
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller), 'metrics');
});

test('attaches the guard when one is provided', () => {
  const controller = createDashboardController('wolter', ['http', 'exception'], TestGuard);
  const guards = Reflect.getMetadata(GUARDS_METADATA, controller);
  assert.deepEqual(guards, [TestGuard]);
});

test('attaches no guard when none is provided', () => {
  const controller = createDashboardController('wolter', ['http', 'exception']);
  assert.equal(Reflect.getMetadata(GUARDS_METADATA, controller), undefined);
});

test('each call produces its own class, independently guarded', () => {
  const guarded = createDashboardController('wolter', ['http', 'exception'], TestGuard);
  const unguarded = createDashboardController('wolter', ['http', 'exception']);
  assert.notEqual(guarded, unguarded);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, guarded), [TestGuard]);
  assert.equal(Reflect.getMetadata(GUARDS_METADATA, unguarded), undefined);
});
