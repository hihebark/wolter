import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexSql, createTableSql, renderDropSchemaSql, renderSchemaSql } from './sql';
import { EVENTS_TABLE, METRICS_TABLE } from './schema';

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

test('renderSchemaSql covers both tables with a custom prefix', () => {
  const sql = renderSchemaSql('acme_wolter_', 'postgres').join('\n');
  assert.match(sql, /"acme_wolter_metrics"/);
  assert.match(sql, /"acme_wolter_events"/);
});

// Regression: renderSchemaSql used to return one joined string, and the
// TypeORM migration renderer re-split it on '\n' — tearing each multi-line
// CREATE TABLE statement into one invalid fragment per column. Asserting the
// exact statement count (not just substring presence) is what would have
// caught that: a fragment-per-line bug still "contains" every substring
// below, it just doesn't appear as one complete array element per statement.
test('renderSchemaSql returns one complete statement per array element — 3 per table (1 CREATE TABLE + 2 CREATE INDEX)', () => {
  for (const dialect of ['postgres', 'mysql', 'sqlite'] as const) {
    const statements = renderSchemaSql('wolter_', dialect);
    assert.equal(statements.length, 6, `expected 6 statements for ${dialect}`);
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    assert.equal(createTables.length, 2, `expected 2 CREATE TABLE statements for ${dialect}`);
    for (const stmt of createTables) {
      assert.ok(stmt.trimEnd().endsWith(');'), `CREATE TABLE statement should be whole and terminated for ${dialect}: ${stmt}`);
    }
  }
});
