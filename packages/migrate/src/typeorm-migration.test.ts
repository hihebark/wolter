import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTypeOrmMigration } from './typeorm-migration';
import { renderSchemaSql, SqlDialect } from './sql';

test('renders a MigrationInterface class with up() creating tables and down() dropping them', () => {
  const source = renderTypeOrmMigration('CreateWolterTables1700000000000', 'wolter_', 'postgres');
  assert.match(source, /export class CreateWolterTables1700000000000 implements MigrationInterface/);
  assert.match(source, /public async up\(queryRunner: QueryRunner\): Promise<void> {/);
  assert.match(source, /queryRunner\.query\(`CREATE TABLE IF NOT EXISTS "wolter_metrics"/);
  assert.match(source, /public async down\(queryRunner: QueryRunner\): Promise<void> {/);
  assert.match(source, /queryRunner\.query\(`DROP TABLE IF EXISTS "wolter_events";`\)/);
});

test('respects the given table prefix and dialect', () => {
  const source = renderTypeOrmMigration('CreateWolterTables1700000000001', 'acme_', 'mysql');
  assert.match(source, /\\`acme_metrics\\`/);
  assert.match(source, /AUTO_INCREMENT/);
});

// Regression for the fragment-per-line bug: up() must issue exactly one
// queryRunner.query() call per SQL statement, never one per line of a
// multi-line CREATE TABLE. Exercised across every supported dialect, not
// just postgres — mysql/sqlite render different column/id syntax but must
// have the same statement-per-call shape.
for (const dialect of ['postgres', 'mysql', 'sqlite'] as const) {
  test(`up() issues exactly one queryRunner.query() call per statement, not per line (${dialect})`, () => {
    const source = renderTypeOrmMigration('CreateWolterTablesRegression', 'wolter_', dialect);
    const upBody = source.slice(source.indexOf('public async up'), source.indexOf('public async down'));
    const queryCalls = upBody.match(/await queryRunner\.query\(/g) ?? [];
    assert.equal(queryCalls.length, renderSchemaSql('wolter_', dialect as SqlDialect).length);
  });

  test(`each CREATE TABLE call contains its full column list, not just the opening paren (${dialect})`, () => {
    const source = renderTypeOrmMigration('CreateWolterTablesRegression', 'wolter_', dialect);
    // The bug produced a call ending right after the opening '(' — e.g.
    // `queryRunner.query(\`CREATE TABLE ... (\`);` — with every column on its
    // own, separately (and invalidly) queried line. A whole statement instead
    // carries the table's last real column through to the closing ');'.
    const opensAt = source.indexOf('CREATE TABLE IF NOT EXISTS');
    const closesAt = source.indexOf(');`);', opensAt);
    assert.notEqual(closesAt, -1, 'expected a `);\\`);` statement terminator after the CREATE TABLE call');
    const statementBody = source.slice(opensAt, closesAt);
    assert.match(statementBody, /timestamp/, `CREATE TABLE call should contain its full column list for ${dialect}, not just the opening paren`);
  });
}
