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

  assert.deepEqual(userTableNames(dbPath), ['wolter_events', 'wolter_labels', 'wolter_metrics', 'wolter_routes']);
});

test('uses a custom table prefix, so Wolter tables can coexist in the host app’s own database', () => {
  const dbPath = tmpDbPath();
  const storage = new SqliteStorage(dbPath, 'myapp_wolter_');
  storage.close();

  assert.deepEqual(userTableNames(dbPath), ['myapp_wolter_events', 'myapp_wolter_labels', 'myapp_wolter_metrics', 'myapp_wolter_routes']);
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
