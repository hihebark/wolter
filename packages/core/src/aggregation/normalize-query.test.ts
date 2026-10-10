import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery, normalizeLabel, throwSite } from './normalize-query';

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

test('normalizeLabel leaves non-query, non-exception labels untouched', () => {
  assert.equal(normalizeLabel({ category: 'http', label: 'GET /x' }), 'GET /x');
});

test('normalizeQuery caps its output at 500 characters — a bulk INSERT does not grow the grouping key unbounded', () => {
  const huge = 'INSERT INTO t (a) VALUES ' + Array.from({ length: 5000 }, (_, i) => `(${i})`).join(',');
  const result = normalizeQuery(huge);
  assert.ok(result.length <= 501); // 500 chars + the trailing ellipsis
  assert.ok(result.endsWith('…'));
});

test('normalizeLabel caps a plain (non-query, non-exception) label too', () => {
  const result = normalizeLabel({ category: 'http', label: 'GET /' + 'x'.repeat(600) });
  assert.ok(result.length <= 501);
});

test('normalizeLabel keeps log labels verbatim (they are the log line shown in the trace waterfall)', () => {
  assert.equal(normalizeLabel({ category: 'log', label: 'Fetched product 000db6e29bba' }), 'Fetched product 000db6e29bba');
});

const cwd = process.cwd();
function stackFor(message: string, frames: string[]): string {
  return `NotFoundException: ${message}\n` + frames.map((f) => `    at ${f}`).join('\n');
}
const APP_FRAMES = [
  `ProductsService.findOne (${cwd}/dist/products/products.service.js:12:11)`,
  `ProductsController.get (${cwd}/dist/products/products.controller.js:20:5)`,
];

test('exceptions group by class + throw site, not by message', () => {
  const a = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'No product named banana', stack: stackFor('No product named banana', APP_FRAMES) } });
  const b = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'No product named purple', stack: stackFor('No product named purple', APP_FRAMES) } });
  assert.equal(a, 'NotFoundException at ProductsService.findOne (dist/products/products.service.js)');
  assert.equal(a, b); // any request value, one group
});

test('a different throw site is a different group', () => {
  const other = [`OrdersService.find (${cwd}/dist/orders/orders.service.js:8:9)`];
  const a = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'x', stack: stackFor('x', APP_FRAMES) } });
  const b = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: 'x', stack: stackFor('x', other) } });
  assert.notEqual(a, b);
});

test('throwSite ignores line/column, so edits above the throw keep the same group', () => {
  const moved = [`ProductsService.findOne (${cwd}/dist/products/products.service.js:97:3)`];
  assert.equal(throwSite(stackFor('x', APP_FRAMES), 'x'), throwSite(stackFor('x', moved), 'x'));
});

test('throwSite skips dependency and Node-internal frames', () => {
  const frames = [
    `new NotFoundException (${cwd}/node_modules/@nestjs/common/exceptions/not-found.exception.js:4:9)`,
    'process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ...APP_FRAMES,
  ];
  assert.equal(throwSite(stackFor('x', frames), 'x'), 'ProductsService.findOne (dist/products/products.service.js)');
});

test('throwSite handles anonymous and async frames', () => {
  assert.equal(throwSite(stackFor('x', [`${cwd}/dist/main.js:3:1`]), 'x'), '<anonymous> (dist/main.js)');
  assert.equal(throwSite(stackFor('x', [`async Svc.run (${cwd}/dist/svc.js:1:1)`]), 'x'), 'Svc.run (dist/svc.js)');
});

// The message is request-controlled and sits inside the stack's first line(s).
test('a message containing fake frame lines cannot choose the throw site', () => {
  const evil = 'bad input\n    at Forged.site (/tmp/forged.js:1:1)';
  const label = normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: evil, stack: stackFor(evil, APP_FRAMES) } });
  assert.equal(label, 'NotFoundException at ProductsService.findOne (dist/products/products.service.js)');
});

test('a stack cut inside the message falls back to the class name instead of guessing', () => {
  const evil = 'line\n    at Forged.site (/tmp/forged.js:1:1)\n' + 'more\n'.repeat(50);
  const truncated = stackFor(evil, APP_FRAMES).split('\n').slice(0, 10).join('\n');
  assert.equal(normalizeLabel({ category: 'exception', label: 'NotFoundException', meta: { message: evil, stack: truncated } }), 'NotFoundException');
});

test('exceptions with no stack, or only library frames, group by class name', () => {
  assert.equal(normalizeLabel({ category: 'exception', label: 'NotFoundException' }), 'NotFoundException');
  assert.equal(normalizeLabel({ category: 'exception', label: 'UnknownError', meta: { message: 'boom' } }), 'UnknownError');
  const libOnly = stackFor('x', [`fn (${cwd}/node_modules/lib/index.js:1:1)`]);
  assert.equal(normalizeLabel({ category: 'exception', label: 'TypeError', meta: { message: 'x', stack: libOnly } }), 'TypeError');
});
