import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException, ForbiddenException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { createDashboardController } from './dashboard.controller';
import { SqliteStorage } from '../storage/sqlite.storage';
import { WolterStorageDriver } from '../interfaces/storage.interface';

type Req = { headers?: Record<string, unknown>; user?: unknown };
interface IssueApi {
  issues(status?: string): unknown;
  issue(id: string, req: Req): Promise<{ viewer: string | null; comments: Array<{ author: string; body: string }> }>;
  updateIssue(id: string, body: unknown, req: Req): Promise<{ status: string; priority: string | null; assignee: string | null }>;
  addComment(id: string, body: unknown, req: Req): Promise<{ author: string; body: string }>;
}

function setup(): { api: IssueApi; storage: SqliteStorage; id: string } {
  const storage = new SqliteStorage(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wolter-issue-api-')), 'wolter.db'));
  storage.issues.touch('NotFoundException at Svc.find (dist/svc.js)', 1_000);
  const Controller = createDashboardController('wolter', ['http']);
  const api = new (Controller as unknown as new (...a: unknown[]) => IssueApi)(storage, { status: () => [] }, { overflowStatus: () => [] });
  return { api, storage, id: String(storage.issues.list()[0].id) };
}

const WRITE: Req = { headers: { 'x-wolter-request': '1' } };

test('writes without the x-wolter-request header are refused (cross-site request protection)', async () => {
  const { api, id } = setup();
  await assert.rejects(api.updateIssue(id, { status: 'resolved' }, { headers: {} }), ForbiddenException);
  await assert.rejects(api.addComment(id, { body: 'hi' }, { headers: { 'x-wolter-request': 'yes' } }), ForbiddenException);
});

test('updateIssue() validates status, priority and assignee', async () => {
  const { api, id } = setup();
  await assert.rejects(api.updateIssue(id, { status: 'done' }, WRITE), BadRequestException);
  await assert.rejects(api.updateIssue(id, { priority: 'urgent' }, WRITE), BadRequestException);
  await assert.rejects(api.updateIssue(id, { assignee: 'x'.repeat(101) }, WRITE), BadRequestException);
  await assert.rejects(api.updateIssue(id, [], WRITE), BadRequestException);
  await assert.rejects(api.updateIssue('abc', { status: 'open' }, WRITE), BadRequestException);
  await assert.rejects(api.updateIssue('999', { status: 'open' }, WRITE), NotFoundException);

  const updated = await api.updateIssue(id, { status: 'resolved', priority: 'high', assignee: '  ana  ' }, WRITE);
  assert.deepEqual([updated.status, updated.priority, updated.assignee], ['resolved', 'high', 'ana']);
  const cleared = await api.updateIssue(id, { priority: null, assignee: '' }, WRITE);
  assert.deepEqual([cleared.priority, cleared.assignee], [null, null]);
});

test('a guard-identified viewer is the comment author, whatever name the body claims', async () => {
  const { api, id } = setup();
  const comment = await api.addComment(id, { body: 'looking into it', author: 'someone-else' }, { ...WRITE, user: { email: 'ana@example.com' } });
  assert.equal(comment.author, 'ana@example.com');
  assert.equal((await api.issue(id, { user: { username: 'ana' } })).viewer, 'ana');
});

test('without a guard identity, the typed name is used, falling back to "anonymous"', async () => {
  const { api, id } = setup();
  assert.equal((await api.addComment(id, { body: 'a', author: 'Bo' }, WRITE)).author, 'Bo');
  assert.equal((await api.addComment(id, { body: 'b' }, WRITE)).author, 'anonymous');
  await assert.rejects(api.addComment(id, { body: '   ' }, WRITE), BadRequestException);
  await assert.rejects(api.addComment(id, { body: 'x'.repeat(5001) }, WRITE), BadRequestException);
  const issue = await api.issue(id, {});
  assert.equal(issue.viewer, null);
  assert.deepEqual(issue.comments.map((c) => c.author), ['Bo', 'anonymous']);
});

test('issues() filters by a valid status only', async () => {
  const { api } = setup();
  assert.equal((api.issues('open') as unknown[]).length, 1);
  assert.equal((api.issues('resolved') as unknown[]).length, 0);
  assert.throws(() => api.issues('closed'), BadRequestException);
});

test('a storage driver without issue support answers 501', () => {
  const Controller = createDashboardController('wolter', ['http']);
  const api = new (Controller as unknown as new (...a: unknown[]) => IssueApi)({} as WolterStorageDriver, { status: () => [] }, { overflowStatus: () => [] });
  assert.throws(() => api.issues(), NotImplementedException);
});

interface ClearApi {
  previewClear(body: unknown, req: Req): Promise<{ metrics: number; events: number }>;
  clear(body: unknown, req: Req): Promise<{ metrics: number; events: number }>;
}

function clearSetup() {
  const { storage } = setup();
  storage.write({ category: 'http', label: 'GET /a', window: 60_000, count: 1, errorCount: 0, slowCount: 0, normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1, timestamp: 60_000 });
  const discarded: unknown[] = [];
  const Controller = createDashboardController('wolter', ['http']);
  const api = new (Controller as unknown as new (...a: unknown[]) => ClearApi)(storage, { status: () => [] }, { overflowStatus: () => [], discard: (f: unknown) => discarded.push(f) });
  return { api, storage, discarded };
}

test('data preview/clear require the write header and a valid filter', async () => {
  const { api } = clearSetup();
  await assert.rejects(api.previewClear({ tables: ['metrics'] }, { headers: {} }), ForbiddenException);
  await assert.rejects(api.clear({ tables: [] }, WRITE), BadRequestException);
  await assert.rejects(api.clear({ tables: ['users'] }, WRITE), BadRequestException);
  await assert.rejects(api.clear({ tables: ['events'], category: 'secrets' }, WRITE), BadRequestException);
  await assert.rejects(api.clear({ tables: ['events'], since: 'yesterday' }, WRITE), BadRequestException);
  await assert.rejects(api.clear({ tables: ['events'], since: 10, until: 5 }, WRITE), BadRequestException);
  await assert.rejects(api.clear({ tables: ['events'], statusCode: 99 }, WRITE), BadRequestException);
  // A status code with metrics selected is a mistake worth saying out loud, not a silent no-op.
  await assert.rejects(api.clear({ tables: ['metrics', 'events'], statusCode: 500 }, WRITE), /raw events only/);
});

test('preview reports counts; clear deletes them and drops matching in-memory metric entries', async () => {
  const { api, storage, discarded } = clearSetup();
  const filter = { tables: ['metrics'], category: 'http', label: 'GET /a' };
  assert.deepEqual(await api.previewClear(filter, WRITE), { metrics: 1, events: 0 });
  assert.equal(discarded.length, 0); // preview never touches the buffer
  assert.deepEqual(await api.clear(filter, WRITE), { metrics: 1, events: 0 });
  assert.equal(storage.query('http', 'custom:0:999999').length, 0);
  assert.deepEqual(discarded, [{ tables: ['metrics'], category: 'http', label: 'GET /a', since: undefined, until: undefined }]);
});
