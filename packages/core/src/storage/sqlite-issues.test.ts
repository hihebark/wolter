import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteStorage } from './sqlite.storage';
import { SYSTEM_AUTHOR } from './sqlite-issues';

function storage(): SqliteStorage {
  return new SqliteStorage(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wolter-issues-')), 'wolter.db'));
}

const FP = 'NotFoundException at ProductsService.findOne (dist/products.service.js)';

test('touch() opens an issue on first sight and advances lastSeen after that', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  s.issues.touch(FP, 5_000);
  s.issues.touch(FP, 3_000); // an older flush never moves lastSeen back
  const [issue] = s.issues.list();
  assert.equal(issue.fingerprint, FP);
  assert.equal(issue.status, 'open');
  assert.equal(issue.firstSeen, 1_000);
  assert.equal(issue.lastSeen, 5_000);
  s.close();
});

test('a resolved issue reopens when it occurs again after being resolved, with an automatic comment', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  const id = s.issues.list()[0].id;
  s.issues.update(id, { status: 'resolved' }, 2_000);

  s.issues.touch(FP, 1_500); // occurred before the resolve — stays resolved
  assert.equal(s.issues.get(id)?.status, 'resolved');

  s.issues.touch(FP, 3_000); // occurred after — a regression
  const issue = s.issues.get(id)!;
  assert.equal(issue.status, 'open');
  assert.equal(issue.resolvedAt, null);
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.comments[0].author, SYSTEM_AUTHOR);
  s.close();
});

test('an ignored issue stays ignored when it occurs again', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  const id = s.issues.list()[0].id;
  s.issues.update(id, { status: 'ignored' }, 2_000);
  s.issues.touch(FP, 3_000);
  assert.equal(s.issues.get(id)?.status, 'ignored');
  assert.equal(s.issues.get(id)?.lastSeen, 3_000);
  s.close();
});

test('update() changes only the given fields and tracks resolvedAt for the current resolution only', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  const id = s.issues.list()[0].id;
  s.issues.update(id, { priority: 'high', assignee: 'ana' }, 2_000);
  let issue = s.issues.update(id, { status: 'resolved' }, 3_000)!;
  assert.deepEqual([issue.priority, issue.assignee, issue.resolvedAt], ['high', 'ana', 3_000]);
  issue = s.issues.update(id, { priority: null }, 4_000)!; // still resolved: resolvedAt kept
  assert.deepEqual([issue.priority, issue.resolvedAt], [null, 3_000]);
  issue = s.issues.update(id, { status: 'open' }, 5_000)!;
  assert.equal(issue.resolvedAt, null);
  assert.equal(s.issues.update(9_999, { status: 'open' }, 1), undefined);
  s.close();
});

test('comments are stored in order and only on existing issues; list() filters by status', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  s.issues.touch('OtherError', 1_000);
  const id = s.issues.list().find((i) => i.fingerprint === FP)!.id;
  s.issues.addComment(id, 'ana', 'first', 10);
  s.issues.addComment(id, 'bo', 'second', 20);
  assert.deepEqual(s.issues.get(id)!.comments.map((c) => [c.author, c.body]), [['ana', 'first'], ['bo', 'second']]);
  assert.equal(s.issues.addComment(9_999, 'ana', 'x', 1), undefined);

  s.issues.update(id, { status: 'resolved' }, 2_000);
  assert.deepEqual(s.issues.list('resolved').map((i) => i.fingerprint), [FP]);
  assert.deepEqual(s.issues.list('open').map((i) => i.fingerprint), ['OtherError']);
  s.close();
});

test('pruning metrics never deletes issues', () => {
  const s = storage();
  s.issues.touch(FP, 1_000);
  s.prune(Date.now(), 0);
  assert.equal(s.issues.list().length, 1);
  s.close();
});
