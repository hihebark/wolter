import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery, normalizeMessage, normalizeLabel } from './normalize-query';

test('strips numeric literals', () => {
  assert.equal(normalizeQuery('SELECT * FROM users WHERE id = 1'), 'SELECT * FROM users WHERE id = ?');
});

test('strips single-quoted string literals', () => {
  assert.equal(normalizeQuery("SELECT * FROM users WHERE name = 'bob'"), 'SELECT * FROM users WHERE name = ?');
});

test('groups differing literal values into the same normalized shape', () => {
  const a = normalizeQuery('SELECT * FROM t WHERE id = 1');
  const b = normalizeQuery('SELECT * FROM t WHERE id = 2');
  assert.equal(a, b);
});

test('normalizeMessage strips numbers, quoted strings, and uuids', () => {
  assert.equal(normalizeMessage('User 123 not found'), 'User ? not found');
  assert.equal(normalizeMessage("Org 'acme' not found"), 'Org ? not found');
  assert.equal(normalizeMessage('User 3f9a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8 not found'), 'User ? not found');
});

test('normalizeLabel folds an exception\'s normalized message into its class name, so two different messages of the same type stay distinct issues', () => {
  const a = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'User 123 not found' } });
  const b = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'User 456 not found' } });
  const c = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'Org 999 not found' } });
  assert.equal(a, b); // same shape once the id is normalized out — one issue
  assert.notEqual(a, c); // genuinely different message — a different issue
  assert.equal(a, 'NotFoundException: User ? not found');
});

test('normalizeLabel falls back to the bare class name when no message is captured', () => {
  assert.equal(normalizeLabel({ category: 'exception', label: 'NotFoundException' }), 'NotFoundException');
});

test('normalizeLabel leaves non-query, non-exception labels untouched', () => {
  assert.equal(normalizeLabel({ category: 'http', label: 'GET /x' }), 'GET /x');
});

test('normalizeQuery caps its output at 500 characters — a bulk INSERT does not grow the grouping key unbounded', () => {
  const huge = 'INSERT INTO t (a) VALUES ' + Array.from({ length: 5000 }, (_, i) => `(${i})`).join(',');
  const result = normalizeQuery(huge);
  assert.ok(result.length <= 501); // 500 chars + the trailing ellipsis
  assert.ok(result.endsWith('…'));
});

test('normalizeLabel caps an exception label at 500 characters even after folding in the message', () => {
  const hugeMessage = 'Invalid input: ' + 'x'.repeat(1000);
  const result = normalizeLabel({ category: 'exception', label: 'ValidationError', meta: { message: hugeMessage } });
  assert.ok(result.length <= 501);
  assert.ok(result.endsWith('…'));
});

test('normalizeLabel caps a plain (non-query, non-exception) label too', () => {
  const result = normalizeLabel({ category: 'http', label: 'GET /' + 'x'.repeat(600) });
  assert.ok(result.length <= 501);
});
