import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexSql, createTableSql, renderDropSchemaSql, renderSchemaSql } from './sql';
import { EVENTS_TABLE, LABELS_TABLE, METRICS_TABLE, ROUTES_TABLE } from './schema';

test('postgres: quotes identifiers, uses BIGSERIAL for the auto-increment id, DOUBLE PRECISION for real columns', () => {
  const sql = createTableSql(EVENTS_TABLE, 'wolter_', 'postgres');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "wolter_events"/);
  assert.match(sql, /"id" BIGSERIAL PRIMARY KEY/);
  assert.match(sql, /"duration" DOUBLE PRECISION NOT NULL/);
  assert.match(sql, /"status_code" INTEGER(?! NOT NULL)/);
});

test('mysql: backtick-quotes identifiers, uses AUTO_INCREMENT', () => {
  const sql = createTableSql(EVENTS_TABLE, 'wolter_', 'mysql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `wolter_events`/);
  assert.match(sql, /`id` BIGINT AUTO_INCREMENT PRIMARY KEY/);
});

test('sqlite: matches SqliteStorage’s own column shape (INTEGER PRIMARY KEY AUTOINCREMENT)', () => {
  const sql = createTableSql(EVENTS_TABLE, 'wolter_', 'sqlite');
  assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
});

test('metrics table gets a composite primary key instead of an id column', () => {
  const sql = createTableSql(METRICS_TABLE, 'wolter_', 'postgres');
  assert.match(sql, /PRIMARY KEY \("category", "label", "window"\)/);
  assert.doesNotMatch(sql, /BIGSERIAL/);
});

test('mysql indexes drop the IF NOT EXISTS guard; postgres/sqlite keep it', () => {
  const [mysql] = createIndexSql(METRICS_TABLE, 'wolter_', 'mysql');
  const [postgres] = createIndexSql(METRICS_TABLE, 'wolter_', 'postgres');
  assert.doesNotMatch(mysql, /IF NOT EXISTS/);
  assert.match(postgres, /IF NOT EXISTS/);
});

test('renderSchemaSql rejects an unsafe table prefix', () => {
  assert.throws(() => renderSchemaSql('wolter-', 'postgres'), /must match/);
  assert.throws(() => renderDropSchemaSql('1wolter_', 'postgres'), /must match/);
});

test('renderSchemaSql covers every table with a custom prefix', () => {
  const sql = renderSchemaSql('acme_wolter_', 'postgres').join('\n');
  assert.match(sql, /"acme_wolter_routes"/);
  assert.match(sql, /"acme_wolter_labels"/);
  assert.match(sql, /"acme_wolter_metrics"/);
  assert.match(sql, /"acme_wolter_events"/);
  assert.match(sql, /"acme_wolter_issues"/);
  assert.match(sql, /"acme_wolter_issue_comments"/);
});

test('issues table has a unique fingerprint and a status index; comments index issue_id', () => {
  const sql = renderSchemaSql('wolter_', 'postgres').join('\n');
  assert.match(sql, /CONSTRAINT "uq_wolter_issues" UNIQUE \("fingerprint"\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "idx_wolter_issues_status"/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "idx_wolter_issue_comments_issue_id"/);
  assert.match(renderSchemaSql('wolter_', 'mysql').join('\n'), /`fingerprint` VARCHAR\(512\) NOT NULL/);
});

// Regression: the generated schema used to stop at metrics/events, so a custom
// driver built on it had nowhere to store resolveRoute()/resolveLabel()'s ids.
test('routes/labels tables get an auto-increment id plus a unique get-or-create key', () => {
  const routes = createTableSql(ROUTES_TABLE, 'wolter_', 'postgres');
  assert.match(routes, /"id" BIGSERIAL PRIMARY KEY/);
  assert.match(routes, /CONSTRAINT "uq_wolter_routes" UNIQUE \("method", "path"\)/);
  const labels = createTableSql(LABELS_TABLE, 'wolter_', 'postgres');
  assert.match(labels, /CONSTRAINT "uq_wolter_labels" UNIQUE \("category", "label"\)/);
});

test('metrics table carries nullable route_id/label_id columns', () => {
  const sql = createTableSql(METRICS_TABLE, 'wolter_', 'postgres');
  assert.match(sql, /"route_id" BIGINT(?! NOT NULL)/);
  assert.match(sql, /"label_id" BIGINT(?! NOT NULL)/);
});

// MySQL rejects an unbounded TEXT column inside a key ("BLOB/TEXT column used in
// key specification without a key length"), so keyed text columns become VARCHAR there.
test('mysql: keyed text columns render as VARCHAR; postgres keeps TEXT', () => {
  assert.match(createTableSql(METRICS_TABLE, 'wolter_', 'mysql'), /`label` VARCHAR\(512\) NOT NULL/);
  assert.match(createTableSql(METRICS_TABLE, 'wolter_', 'postgres'), /"label" TEXT NOT NULL/);
  assert.match(createTableSql(EVENTS_TABLE, 'wolter_', 'mysql'), /`meta` TEXT NOT NULL/);
});

test('renderDropSchemaSql drops metrics before the routes/labels tables it points at', () => {
  const drops = renderDropSchemaSql('wolter_', 'postgres');
  const at = (name: string) => drops.findIndex((d) => d.includes(`"wolter_${name}"`));
  assert.ok(at('metrics') < at('routes'));
  assert.ok(at('metrics') < at('labels'));
});

// Regression: renderSchemaSql used to return one joined string, and the
// TypeORM migration renderer re-split it on '\n' — tearing each multi-line
// CREATE TABLE statement into one invalid fragment per column. Asserting the
// exact statement count (not just substring presence) is what would have
// caught that: a fragment-per-line bug still "contains" every substring
// below, it just doesn't appear as one complete array element per statement.
test('renderSchemaSql returns one complete statement per array element — 6 CREATE TABLE + 8 CREATE INDEX', () => {
  for (const dialect of ['postgres', 'mysql', 'sqlite'] as const) {
    const statements = renderSchemaSql('wolter_', dialect);
    assert.equal(statements.length, 14, `expected 14 statements for ${dialect}`);
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    assert.equal(createTables.length, 6, `expected 6 CREATE TABLE statements for ${dialect}`);
    for (const stmt of createTables) {
      assert.ok(stmt.trimEnd().endsWith(');'), `CREATE TABLE statement should be whole and terminated for ${dialect}: ${stmt}`);
    }
  }
});
