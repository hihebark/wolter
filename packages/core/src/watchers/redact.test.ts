import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactFields, redactHeaders, truncateBody } from './redact';

test('redactHeaders masks known-sensitive header names case-insensitively', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', Cookie: 'a=b', 'Content-Type': 'application/json' });
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out['Content-Type'], 'application/json');
});

test('redactHeaders handles an undefined/empty header set', () => {
  assert.deepEqual(redactHeaders(undefined), {});
});

test('redactHeaders masks app-supplied extra header names, case-insensitively', () => {
  const out = redactHeaders({ 'X-Session-Id': 'abc', 'Content-Type': 'application/json' }, ['x-session-id']);
  assert.equal(out['X-Session-Id'], '[redacted]');
  assert.equal(out['Content-Type'], 'application/json');
});

test('redactFields is a no-op with no field names given', () => {
  const body = { name: 'Ada', password: 'hunter2' };
  assert.deepEqual(redactFields(body, []), body);
});

test('redactFields masks named fields at any nesting depth, case-insensitively', () => {
  const body = { name: 'Ada', Password: 'hunter2', profile: { ssn: '123-45-6789' }, tags: [{ token: 'x' }] };
  const out = redactFields(body, ['password', 'ssn', 'token']) as any;
  assert.equal(out.name, 'Ada');
  assert.equal(out.Password, '[redacted]');
  assert.equal(out.profile.ssn, '[redacted]');
  assert.equal(out.tags[0].token, '[redacted]');
});

test('redactFields tolerates a circular reference instead of recursing forever', () => {
  const body: Record<string, unknown> = { name: 'Ada', password: 'hunter2' };
  body.self = body;
  const out = redactFields(body, ['password']) as any;
  assert.equal(out.name, 'Ada');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.self, '[circular]');
});

test('redactFields does not falsely flag a shared-but-acyclic reference as circular', () => {
  const shared = { token: 'x' };
  const body = { a: shared, b: shared };
  const out = redactFields(body, ['token']) as any;
  // Same object reachable from two sibling branches, neither an ancestor of
  // the other — must be walked (and redacted) normally in both places, not
  // treated as a cycle just because it was visited once already.
  assert.equal(out.a.token, '[redacted]');
  assert.equal(out.b.token, '[redacted]');
});

test('truncateBody passes small values through untouched', () => {
  const body = { hello: 'world' };
  assert.deepEqual(truncateBody(body), body);
});

test('truncateBody caps oversized values with a preview', () => {
  const big = { data: 'x'.repeat(20_000) };
  const result = truncateBody(big, 100) as { truncated: boolean; preview: string };
  assert.equal(result.truncated, true);
  assert.ok(result.preview.length <= 100);
});
