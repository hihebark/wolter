import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './cli';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wolter-migrate-'));
}

test('generate --target typeorm writes a migration file into --dir', () => {
  const dir = tmpDir();
  const code = run(['generate', '--target', 'typeorm', '--dir', dir], () => {});
  assert.equal(code, 0);
  const [file] = fs.readdirSync(dir);
  assert.match(file, /^\d+-create-wolter-tables\.ts$/);
  assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), /implements MigrationInterface/);
});

test('generate --target prisma writes wolter.prisma into --dir', () => {
  const dir = tmpDir();
  run(['generate', '--target', 'prisma', '--dir', dir], () => {});
  assert.match(fs.readFileSync(path.join(dir, 'wolter.prisma'), 'utf8'), /model WolterMetric/);
});

test('generate --target sql --dialect mysql writes wolter-mysql.sql into --dir', () => {
  const dir = tmpDir();
  run(['generate', '--target', 'sql', '--dialect', 'mysql', '--dir', dir], () => {});
  assert.match(fs.readFileSync(path.join(dir, 'wolter-mysql.sql'), 'utf8'), /CREATE TABLE IF NOT EXISTS `wolter_metrics`/);
});

test('respects --prefix', () => {
  const dir = tmpDir();
  run(['generate', '--target', 'sql', '--dir', dir, '--prefix', 'acme_'], () => {});
  assert.match(fs.readFileSync(path.join(dir, 'wolter-postgres.sql'), 'utf8'), /"acme_metrics"/);
});

test('rejects an unknown --target and writes nothing', () => {
  const dir = tmpDir();
  const messages: string[] = [];
  const code = run(['generate', '--target', 'bogus', '--dir', dir], (m) => messages.push(m));
  assert.equal(code, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(messages[0], /Unknown --target 'bogus'/);
});

test('no command prints usage without erroring', () => {
  const messages: string[] = [];
  const code = run([], (m) => messages.push(m));
  assert.equal(code, 0);
  assert.match(messages[0], /Usage: wolter-migrate generate/);
});
