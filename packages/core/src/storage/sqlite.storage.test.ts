import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteStorage } from './sqlite.storage';

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wolter-sqlite-')), 'wolter.db');
}

function userTableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string;
  }>;
  db.close();
  return tables.map((t) => t.name).sort();
}

test('defaults to wolter_-prefixed table names', () => {
  const dbPath = tmpDbPath();
  const storage = new SqliteStorage(dbPath);
  storage.close();

  assert.deepEqual(userTableNames(dbPath), ['wolter_events', 'wolter_issue_comments', 'wolter_issues', 'wolter_labels', 'wolter_metrics', 'wolter_routes']);
});

test('uses a custom table prefix, so Wolter tables can coexist in the host app’s own database', () => {
  const dbPath = tmpDbPath();
  const storage = new SqliteStorage(dbPath, 'myapp_wolter_');
  storage.close();

  assert.deepEqual(userTableNames(dbPath), ['myapp_wolter_events', 'myapp_wolter_issue_comments', 'myapp_wolter_issues', 'myapp_wolter_labels', 'myapp_wolter_metrics', 'myapp_wolter_routes']);
});

test('rejects a table prefix that is not a safe SQL identifier', () => {
  assert.throws(() => new SqliteStorage(tmpDbPath(), 'wolter-'), /must match/);
  assert.throws(() => new SqliteStorage(tmpDbPath(), '1wolter_'), /must match/);
  assert.throws(() => new SqliteStorage(tmpDbPath(), 'wolter; DROP TABLE x;--'), /must match/);
});

test('resolveRoute assigns a stable id to a (method, path) pair and reuses it on subsequent hits', () => {
  const storage = new SqliteStorage(tmpDbPath());
  const first = storage.resolveRoute('GET', '/users/:id');
  const second = storage.resolveRoute('GET', '/users/:id');
  const other = storage.resolveRoute('POST', '/users/:id');
  storage.close();

  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('query() joins the resolved route back onto its metric bucket', async () => {
  const storage = new SqliteStorage(tmpDbPath());
  const routeId = storage.resolveRoute('GET', '/users/:id');
  const now = Date.now();
  await storage.write({
    category: 'http', label: 'GET /users/:id', window: now, count: 1, errorCount: 0, slowCount: 0,
    normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 5, min: 5, max: 5,
    p50: 5, p95: 5, p99: 5, timestamp: now, routeId,
  });
  const [row] = await storage.query('http', '30d');
  storage.close();

  assert.equal(row.routeId, routeId);
  assert.equal(row.method, 'GET');
  assert.equal(row.path, '/users/:id');
});

test('resolveLabel assigns a stable id per (category, label), independent across categories', () => {
  const storage = new SqliteStorage(tmpDbPath());
  const first = storage.resolveLabel('query', 'SELECT * FROM t WHERE id = ?');
  const second = storage.resolveLabel('query', 'SELECT * FROM t WHERE id = ?');
  const sameLabelOtherCategory = storage.resolveLabel('exception', 'SELECT * FROM t WHERE id = ?');
  storage.close();

  assert.equal(first, second);
  assert.notEqual(first, sameLabelOtherCategory);
});

test('query() surfaces the resolved labelId for a non-http bucket', async () => {
  const storage = new SqliteStorage(tmpDbPath());
  const labelId = storage.resolveLabel('query', 'SELECT 1');
  const now = Date.now();
  await storage.write({
    category: 'query', label: 'SELECT 1', window: now, count: 1, errorCount: 0, slowCount: 0,
    normalCount: 0, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 5, min: 5, max: 5,
    p50: 5, p95: 5, p99: 5, timestamp: now, labelId,
  });
  const [row] = await storage.query('query', '30d');
  storage.close();

  assert.equal(row.labelId, labelId);
  assert.equal(row.routeId, undefined);
  assert.equal(row.method, undefined);
  assert.equal(row.path, undefined);
});

test('prune sweeps routes/labels no longer referenced by any metric bucket, but keeps ones still in use', async () => {
  const storage = new SqliteStorage(tmpDbPath());
  const now = Date.now();

  // Resolved but never written into a metric bucket — nothing references them.
  const orphanRouteId = storage.resolveRoute('DELETE', '/gone');
  const orphanLabelId = storage.resolveLabel('query', 'DELETE FROM gone');

  // Referenced by a bucket that survives the prune (timestamp is well after the cutoff below).
  const keptRouteId = storage.resolveRoute('GET', '/kept');
  const keptLabelId = storage.resolveLabel('query', 'SELECT kept');
  await storage.write({
    category: 'http', label: 'GET /kept', window: now, count: 1, errorCount: 0, slowCount: 0,
    normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1,
    p50: 1, p95: 1, p99: 1, timestamp: now, routeId: keptRouteId,
  });
  await storage.write({
    category: 'query', label: 'SELECT kept', window: now, count: 1, errorCount: 0, slowCount: 0,
    normalCount: 0, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1,
    p50: 1, p95: 1, p99: 1, timestamp: now, labelId: keptLabelId,
  });

  storage.prune(0); // olderThan=0 deletes no metric rows — isolates the orphan sweep itself

  // A fresh resolve after prune gets a brand-new autoincrement id for the swept ones (their
  // row was actually deleted), but the same id as before for the still-referenced ones.
  assert.notEqual(storage.resolveRoute('DELETE', '/gone'), orphanRouteId);
  assert.notEqual(storage.resolveLabel('query', 'DELETE FROM gone'), orphanLabelId);
  assert.equal(storage.resolveRoute('GET', '/kept'), keptRouteId);
  assert.equal(storage.resolveLabel('query', 'SELECT kept'), keptLabelId);
  storage.close();
});

function bucket(category: string, label: string, window: number, count = 1) {
  return {
    category, label, window, count, errorCount: 0, slowCount: 0, normalCount: 0, clientErrorCount: 0, serverErrorCount: 0,
    totalDuration: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, timestamp: window,
  };
}

test('writeBatch() upserts every bucket in one call, same result as write()', () => {
  const storage = new SqliteStorage(tmpDbPath());
  storage.writeBatch([bucket('http', 'GET /a', 0, 1), bucket('http', 'GET /b', 0, 2)]);
  storage.writeBatch([bucket('http', 'GET /a', 0, 5)]); // upsert, not duplicate
  const rows = storage.query('http', 'custom:-1:1');
  assert.deepEqual(rows.map((r) => [r.label, r.count]).sort(), [['GET /a', 5], ['GET /b', 2]]);
  storage.close();
});

test('writeBatch() is all or nothing: a failing bucket rolls back the whole batch', () => {
  const storage = new SqliteStorage(tmpDbPath());
  const bad = { ...bucket('http', 'GET /bad', 0), count: null as unknown as number }; // violates NOT NULL
  assert.throws(() => storage.writeBatch([bucket('http', 'GET /ok', 0), bad]));
  assert.equal(storage.query('http', 'custom:-1:1').length, 0);
  storage.close();
});

// Regression for unbounded label cardinality: metrics used to be pruned by age
// only, so storage size tracked how many distinct labels traffic produced.
test('prune(olderThan, maxRowsPerCategory) keeps only the newest N buckets per category', () => {
  const dbPath = tmpDbPath();
  const storage = new SqliteStorage(dbPath);
  for (let w = 1; w <= 10; w++) {
    storage.write({ ...bucket('exception', `E${w}`, w * 60_000), labelId: storage.resolveLabel('exception', `E${w}`) });
  }
  storage.write(bucket('http', 'GET /keep', 60_000));

  storage.prune(0, 3);

  const exceptions = storage.query('exception', `custom:0:${11 * 60_000}`).map((r) => r.label);
  assert.deepEqual(exceptions, ['E8', 'E9', 'E10']); // newest kept
  assert.equal(storage.query('http', `custom:0:${11 * 60_000}`).length, 1); // other categories untouched
  storage.close();
  // Labels whose last bucket was trimmed are swept in the same pass.
  const db = new Database(dbPath);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wolter_labels WHERE category = 'exception'").get() as { n: number }).n, 3);
  db.close();
});

test('prune(olderThan) without a size cap still prunes by age only', () => {
  const storage = new SqliteStorage(tmpDbPath());
  storage.writeBatch([bucket('http', 'GET /old', 1_000), bucket('http', 'GET /new', 120_000)]);
  storage.prune(60_000);
  assert.deepEqual(storage.query('http', 'custom:0:200000').map((r) => r.label), ['GET /new']);
  storage.close();
});

function rawEvent(category: string, label: string, timestamp: number, statusCode?: number) {
  return { category, label, status: 'ok', statusCode, duration: 1, meta: {}, timestamp };
}

function seeded(): SqliteStorage {
  const storage = new SqliteStorage(tmpDbPath());
  storage.write({ ...bucket('http', 'GET /a', 60_000), labelId: storage.resolveLabel('http', 'GET /a') });
  storage.write(bucket('http', 'GET /a', 120_000));
  storage.write(bucket('http', 'GET /b', 60_000));
  storage.write(bucket('exception', 'TypeError', 60_000));
  storage.writeEvent(rawEvent('http', 'GET /a', 60_000, 500));
  storage.writeEvent(rawEvent('http', 'GET /a', 61_000, 200));
  storage.writeEvent(rawEvent('http', 'GET /b', 62_000, 500));
  storage.issues.touch('TypeError', 60_000);
  return storage;
}

test('clearData(dryRun) counts matches without deleting; the real run deletes exactly those', () => {
  const storage = seeded();
  const filter = { tables: ['metrics', 'events'] as Array<'metrics' | 'events'>, category: 'http', label: 'GET /a' };
  assert.deepEqual(storage.clearData(filter, true), { metrics: 2, events: 2 });
  assert.deepEqual(storage.clearData(filter, true), { metrics: 2, events: 2 }); // nothing deleted yet
  assert.deepEqual(storage.clearData(filter, false), { metrics: 2, events: 2 });
  assert.deepEqual(storage.query('http', 'custom:0:999999').map((r) => r.label), ['GET /b']);
  assert.equal(storage.issues.list().length, 1); // issues are never cleared
  storage.close();
});

test('clearData filters by time range [since, until) and by table', () => {
  const storage = seeded();
  assert.deepEqual(storage.clearData({ tables: ['metrics'], since: 60_000, until: 120_000 }, false), { metrics: 3, events: 0 });
  assert.deepEqual(storage.query('http', 'custom:0:999999').map((r) => r.window), [120_000]);
  assert.equal(storage.queryEvents('http', 'GET /a', 'custom:0:999999', 50).length, 2);
  storage.close();
});

test('a status-code filter applies to raw events only and never matches metric buckets', () => {
  const storage = seeded();
  assert.deepEqual(storage.clearData({ tables: ['metrics', 'events'], statusCode: 500 }, false), { metrics: 0, events: 2 });
  assert.equal(storage.query('http', 'custom:0:999999').length, 3);
  assert.deepEqual(storage.queryEvents('http', 'GET /a', 'custom:0:999999', 50).map((e) => e.statusCode), [200]);
  storage.close();
});
