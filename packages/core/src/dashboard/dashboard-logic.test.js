const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml, summarize, splitLabel, relativeTime, denseWindows, bucketMsForRange,
  timeSeries, statusSeries, queryStatusSeries, durationSeries, metricSeries, latestMetric, labelSeries,
  table, pageCount, previewRows, ms, durationCellClass, nonZeroClass, eventRow, eventsList, occurrenceBody, kvRow, occurrenceEventsSummaryHtml,
  bucketTooltip, traceRows, traceTicks, niceStep, traceWaterfallHtml,
  formatSql, traceDuplicateCounts, traceDuplicateQueryCount, occurrenceMarkdown, occurrenceAiPrompt,
} = require('./dashboard-logic.js');

test('escapeHtml neutralizes HTML-significant characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('summarize collapses multiple time-bucket rows into one per label, keyed on worst p95', () => {
  const rows = [
    { label: 'GET /x', window: 1000, count: 2, errorCount: 0, slowCount: 0, normalCount: 2, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 10, min: 2, max: 8, p50: 4, p95: 8, p99: 8 },
    { label: 'GET /x', window: 2000, count: 3, errorCount: 1, slowCount: 0, normalCount: 2, clientErrorCount: 1, serverErrorCount: 0, totalDuration: 15, min: 1, max: 12, p50: 5, p95: 12, p99: 12 },
    { label: 'GET /y', window: 1000, count: 1, errorCount: 0, slowCount: 0, normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 },
  ];
  const summary = summarize(rows);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].label, 'GET /x'); // sorted by p95 desc
  assert.equal(summary[0].count, 5);
  assert.equal(summary[0].errorCount, 1);
  assert.equal(summary[0].min, 1);
  assert.equal(summary[0].p50, 5);
  assert.equal(summary[0].p95, 12);
  assert.equal(summary[0].p99, 12);
  assert.equal(summary[0].lastSeen, 2000);
  assert.equal(summary[0].firstSeen, 1000);
});

test('summarize carries the backend-resolved method/path through, so the dashboard never has to split the label', () => {
  const rows = [
    { label: 'GET /users/:id', method: 'GET', path: '/users/:id', window: 1000, count: 1, errorCount: 0, slowCount: 0, normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 },
  ];
  const [summary] = summarize(rows);
  assert.equal(summary.method, 'GET');
  assert.equal(summary.path, '/users/:id');
});

test('summarize picks up method/path from a later row even when the oldest row in the merge has none (pre-upgrade data)', () => {
  const rows = [
    { label: 'GET /users/:id', method: undefined, path: undefined, window: 1000, count: 1, errorCount: 0, slowCount: 0, normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 },
    { label: 'GET /users/:id', method: 'GET', path: '/users/:id', window: 2000, count: 1, errorCount: 0, slowCount: 0, normalCount: 1, clientErrorCount: 0, serverErrorCount: 0, totalDuration: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 },
  ];
  const [summary] = summarize(rows);
  assert.equal(summary.method, 'GET');
  assert.equal(summary.path, '/users/:id');
});

test('splitLabel separates HTTP method from path', () => {
  assert.deepEqual(splitLabel('GET /users/:id'), { method: 'GET', path: '/users/:id' });
  assert.deepEqual(splitLabel('/no-method'), { method: '', path: '/no-method' });
});

test('relativeTime buckets into just now / minutes / hours / days', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago');
});

test('denseWindows spans exactly the requested range at 1-minute resolution', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const windows = denseWindows('1h', now);
  assert.equal(windows.length, 60);
  assert.equal(windows[windows.length - 1], Math.floor(now / 60_000) * 60_000);
});

test('timeSeries zero-fills buckets with no matching rows instead of dropping them', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [{ window: bucket, count: 7 }];
  const series = timeSeries(rows, '1h', now);
  assert.equal(series.length, 60);
  assert.equal(series[series.length - 1].count, 7);
  assert.equal(series[0].count, 0);
});

test('bucketMsForRange uses 1-minute buckets for short ranges, coarser for 7d/30d', () => {
  assert.equal(bucketMsForRange('1h'), 60_000);
  assert.equal(bucketMsForRange('24h'), 60_000);
  assert.equal(bucketMsForRange('7d'), 3_600_000);
  assert.equal(bucketMsForRange('30d'), 21_600_000);
});

test('denseWindows respects a coarser bucketMs — 7d at 1h buckets is 168 points, not 10080', () => {
  const now = Date.parse('2026-01-08T00:00:00Z');
  const windows = denseWindows('7d', now, 3_600_000);
  assert.equal(windows.length, 168);
});

test('timeSeries collapses many 1-minute rows into one coarse bucket for long ranges', () => {
  const now = Date.parse('2026-01-08T00:00:00Z');
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  // 3 one-minute rows inside the same hour should sum into a single 1h bucket.
  const rows = [
    { window: hourStart, count: 2 },
    { window: hourStart + 60_000, count: 3 },
    { window: hourStart + 120_000, count: 5 },
  ];
  const series = timeSeries(rows, '7d', now, 3_600_000);
  assert.equal(series.length, 168);
  const last = series[series.length - 1];
  assert.equal(last.window, hourStart);
  assert.equal(last.count, 10);
});

test('statusSeries sums normal/clientError/serverError per window across labels', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [
    { window: bucket, normalCount: 5, clientErrorCount: 1, serverErrorCount: 0 },
    { window: bucket, normalCount: 2, clientErrorCount: 0, serverErrorCount: 1 },
  ];
  const series = statusSeries(rows, '1h', now);
  const last = series[series.length - 1];
  assert.equal(last.normal, 7);
  assert.equal(last.clientError, 1);
  assert.equal(last.serverError, 1);
});

test('queryStatusSeries derives ok as count minus slow minus error', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [{ window: bucket, count: 10, slowCount: 2, errorCount: 1 }];
  const series = queryStatusSeries(rows, '1h', now);
  const last = series[series.length - 1];
  assert.equal(last.ok, 7);
  assert.equal(last.slow, 2);
  assert.equal(last.error, 1);
});

test('durationSeries computes count-weighted avg and the window max', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [
    { window: bucket, totalDuration: 100, count: 10, max: 30 },
    { window: bucket, totalDuration: 50, count: 10, max: 40 },
  ];
  const series = durationSeries(rows, '1h', now);
  const last = series[series.length - 1];
  assert.equal(last.avg, 7.5); // (100+50)/(10+10)
  assert.equal(last.max, 40);
});

test('metricSeries isolates one runtime label and averages multiple samples per window', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [
    { window: bucket, label: 'cpu', totalDuration: 30, count: 2 }, // avg 15
    { window: bucket, label: 'heap', totalDuration: 900, count: 1 },
  ];
  const series = metricSeries(rows, 'cpu', '1h', now);
  const last = series[series.length - 1];
  assert.equal(last.avg, 15);
  assert.equal(series.length, 60);
});

test('latestMetric returns the most recent window\'s average for a label, 0 if none', () => {
  const rows = [
    { window: 1000, label: 'cpu', totalDuration: 10, count: 1 },
    { window: 2000, label: 'cpu', totalDuration: 40, count: 2 }, // avg 20, later window
  ];
  assert.equal(latestMetric(rows, 'cpu'), 20);
  assert.equal(latestMetric(rows, 'heap'), 0);
});

test('labelSeries isolates one item across categories, ignoring other labels', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bucket = Math.floor(now / 60_000) * 60_000;
  const rows = [
    { window: bucket, label: 'GET /users', count: 4, errorCount: 1, slowCount: 0, totalDuration: 40, max: 15 },
    { window: bucket, label: 'GET /other', count: 99, errorCount: 99, slowCount: 99, totalDuration: 9999, max: 999 },
  ];
  const series = labelSeries(rows, 'GET /users', '1h', now);
  const last = series[series.length - 1];
  assert.equal(last.count, 4);
  assert.equal(last.errorCount, 1);
  assert.equal(last.avg, 10);
  assert.equal(last.max, 15);
});

test('table rows carry a data-label attribute for the click-to-detail view', () => {
  const rows = [{ label: 'GET "quoted" & <tricky>' }];
  const cols = [{ label: 'X', fmt: r => r.label }];
  const html = table(rows, cols, 0);
  assert.ok(html.includes('data-label="GET &quot;quoted&quot; &amp; &lt;tricky&gt;"'));
});

test('previewRows caps at 3 items and escapes content', () => {
  const items = [{ label: 'a<script>' }, { label: 'b' }, { label: 'c' }, { label: 'd' }];
  const html = previewRows(items, r => r.label, () => '5ms');
  assert.equal((html.match(/preview-row/g) || []).length, 3);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('previewRows shows an empty state for no items', () => {
  assert.ok(previewRows([], r => r.label, () => '').includes('No data yet'));
});

test('table paginates 20 rows per page', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ n: i }));
  const cols = [{ label: 'N', num: true, fmt: r => r.n }];
  assert.equal(pageCount(rows), 3);
  const page0 = table(rows, cols, 0);
  const page2 = table(rows, cols, 2);
  const bodyRowCount = (html) => (html.split('<tbody>')[1].match(/<tr /g) || []).length;
  assert.equal(bodyRowCount(page0), 20);
  assert.equal(bodyRowCount(page2), 5); // last page, remainder
});

test('table sorts by a column\'s sort accessor, not its display fmt string', () => {
  const rows = [{ label: 'a', ms: 120 }, { label: 'b', ms: 15 }, { label: 'c', ms: 9 }];
  const cols = [{ label: 'Label', fmt: r => r.label }, { label: 'Duration', num: true, fmt: r => r.ms + 'ms', sort: r => r.ms }];
  const asc = table(rows, cols, 0, { index: 1, dir: 1 });
  const rowLabels = (html) => [...html.matchAll(/data-label="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(rowLabels(asc), ['c', 'b', 'a']);
  const desc = table(rows, cols, 0, { index: 1, dir: -1 });
  assert.deepEqual(rowLabels(desc), ['a', 'b', 'c']);
});

test('table only marks columns with a sort accessor as sortable, and flags the active one', () => {
  const rows = [{ label: 'a', n: 1 }];
  const cols = [{ label: 'Label', fmt: r => r.label }, { label: 'N', num: true, fmt: r => r.n, sort: r => r.n }];
  const html = table(rows, cols, 0, { index: 1, dir: -1 });
  assert.ok(!/<th class="[^"]*sortable[^"]*"[^>]*>Label/.test(html));
  assert.ok(/<th class="[^"]*sortable sorted[^"]*" data-col-index="1">N ▼/.test(html));
});

test('table falls back to the given row order when no sort is active', () => {
  const rows = [{ label: 'z' }, { label: 'a' }];
  const cols = [{ label: 'Label', fmt: r => r.label }];
  const rowLabels = (html) => [...html.matchAll(/data-label="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(rowLabels(table(rows, cols, 0)), ['z', 'a']);
});

test('table escapes row content', () => {
  const rows = [{ label: '<img onerror=alert(1)>' }];
  const cols = [{ label: 'X', fmt: r => r.label }];
  const html = table(rows, cols, 0);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('table applies a column\'s cellCls to that cell only, unaffected by other columns', () => {
  const rows = [{ label: 'a', ms: 1500 }];
  const cols = [
    { label: 'Label', fmt: r => r.label },
    { label: 'Dur', num: true, fmt: r => r.ms, cellCls: r => durationCellClass(r.ms) },
  ];
  const html = table(rows, cols, 0);
  assert.ok(/<td class="num num-critical">1500<\/td>/.test(html));
  assert.ok(!/<td class="num-critical">a/.test(html));
});

test('durationCellClass thresholds at 300ms (warn) and 1000ms (critical)', () => {
  assert.equal(durationCellClass(299), '');
  assert.equal(durationCellClass(300), 'num-warn');
  assert.equal(durationCellClass(999), 'num-warn');
  assert.equal(durationCellClass(1000), 'num-critical');
});

test('nonZeroClass flags any positive count with the given severity, zero stays unstyled', () => {
  assert.equal(nonZeroClass(0, 'critical'), '');
  assert.equal(nonZeroClass(1, 'critical'), 'num-critical');
  assert.equal(nonZeroClass(5, 'warn'), 'num-warn');
});

test('ms rounds to whole milliseconds with a unit suffix', () => {
  assert.equal(ms(12.6), '13ms');
  assert.equal(ms(0), '0ms');
});

test('eventRow renders a clickable summary carrying the event id, escaping content', () => {
  const ev = { id: 7, label: 'GET /users', statusCode: 200, duration: 12, timestamp: Date.now(), meta: { method: 'GET', path: '<script>' } };
  const html = eventRow(ev, 'http');
  assert.ok(html.includes('data-event-id="7"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('eventRow builds an exception summary from the captured message', () => {
  const html = eventRow({ id: 1, label: 'NotFoundException', timestamp: Date.now(), meta: { message: 'not found' } }, 'exception');
  assert.ok(html.includes('not found'));
});

test('eventsList shows an empty state for no events', () => {
  assert.ok(eventsList([], 'http').includes('No recent occurrences'));
});

test('occurrenceBody renders http headers/body when captured, escaping content', () => {
  const ev = {
    label: 'GET /users', statusCode: 200, duration: 12, timestamp: Date.now(),
    meta: { method: 'GET', path: '/users', headers: { authorization: '[redacted]' }, body: { name: '<script>' } },
  };
  const html = occurrenceBody(ev, 'http');
  assert.ok(html.includes('Headers'));
  assert.ok(html.includes('Body'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('occurrenceBody shows a hint instead of headers/body when not captured', () => {
  const ev = { label: 'GET /users', statusCode: 200, duration: 12, timestamp: Date.now(), meta: { method: 'GET', path: '/users' } };
  assert.ok(occurrenceBody(ev, 'http').includes('enable capture.headers / capture.body'));
});

test('occurrenceBody renders an exception stack when present', () => {
  const ev = { label: 'NotFoundException', timestamp: Date.now(), meta: { message: 'not found', stack: 'Error: not found\n  at x' } };
  const html = occurrenceBody(ev, 'exception');
  assert.ok(html.includes('Error: not found'));
});

test('occurrenceBody renders query parameters when captured, else a hint', () => {
  const withParams = occurrenceBody({ label: 'SELECT ?', duration: 3, timestamp: Date.now(), meta: { parameters: [1] } }, 'query');
  assert.ok(withParams.includes('Parameters'));
  const withoutParams = occurrenceBody({ label: 'SELECT ?', duration: 3, timestamp: Date.now(), meta: {} }, 'query');
  assert.ok(withoutParams.includes('enable captureParameters'));
});

test('kvRow escapes the label but passes the value through as given', () => {
  const html = kvRow('<b>Date</b>', '<span class="x">1</span>');
  assert.ok(html.includes('&lt;b&gt;Date&lt;/b&gt;'));
  assert.ok(html.includes('<span class="x">1</span>'));
});

test('occurrenceEventsSummaryHtml tallies correlated queries and excludes the anchor event', () => {
  const traceEvents = [
    { id: 1, category: 'http', duration: 100 },
    { id: 2, category: 'query', duration: 10 },
    { id: 3, category: 'query', duration: 5 },
  ];
  const html = occurrenceEventsSummaryHtml(traceEvents, 1);
  assert.ok(html.includes('2 total'));
  assert.ok(html.includes('15ms'));
});

test('occurrenceEventsSummaryHtml shows zero queries and omits exceptions when none occurred', () => {
  const html = occurrenceEventsSummaryHtml([{ id: 1, category: 'http', duration: 100 }], 1);
  assert.ok(html.includes('kv-muted'));
  assert.ok(!html.includes('Exceptions'));
});

test('occurrenceEventsSummaryHtml surfaces correlated exceptions', () => {
  const traceEvents = [{ id: 1, category: 'http' }, { id: 2, category: 'exception' }];
  assert.ok(occurrenceEventsSummaryHtml(traceEvents, 1).includes('Exceptions'));
});

test('niceStep picks a round interval keeping the ruler to about 8 ticks or fewer', () => {
  assert.equal(niceStep(100), 25);
  assert.equal(niceStep(450), 100);
  assert.ok(450 / niceStep(450) <= 8);
});

test('traceTicks spans zero to the full duration at the chosen step', () => {
  const ticks = traceTicks(100);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 100);
});

test('bucketTooltip labels status-code keys and appends a total', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const text = bucketTooltip(now, ['normal', 'clientError', 'serverError'], [2233, 0, 0]);
  assert.ok(text.includes('1-3xx: 2233'));
  assert.ok(text.includes('4xx: 0'));
  assert.ok(text.includes('5xx: 0'));
  assert.ok(text.includes('total: 2233'));
});

test('bucketTooltip formats duration keys in ms and omits the total line', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const text = bucketTooltip(now, ['avg', 'max'], [60.667, 117.8]);
  assert.ok(text.includes('avg: 61ms'));
  assert.ok(text.includes('max: 118ms'));
  assert.ok(!text.includes('total'));
});

test('traceRows positions each event relative to the trace start and total span', () => {
  const events = [
    { category: 'http', label: 'GET /users', duration: 100, timestamp: 1000 },
    { category: 'query', label: 'SELECT 1', duration: 10, timestamp: 1020 },
  ];
  const rows = traceRows(events);
  assert.equal(rows[0].offsetPct, 0);
  assert.equal(rows[0].widthPct, 100);
  assert.equal(rows[1].offsetPct, 20);
  assert.equal(rows[1].widthPct, 10);
});

test('traceRows floors bar width so zero-duration events stay visible', () => {
  const events = [{ category: 'query', label: 'BEGIN', duration: 0, timestamp: 1000 }];
  const rows = traceRows(events);
  assert.ok(rows[0].widthPct >= 0.6);
});

test('traceWaterfallHtml shows an empty state for no correlated events', () => {
  assert.ok(traceWaterfallHtml([]).includes('No correlated events found'));
});

test('traceWaterfallHtml renders a labeled, escaped row per event, plus a tick ruler', () => {
  const html = traceWaterfallHtml([{ category: 'exception', label: '<script>', duration: 5, timestamp: 1000 }]);
  assert.ok(html.includes('trace-ruler'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('5ms'));
});

test('formatSql breaks a query onto multiple lines before its major clauses', () => {
  const formatted = formatSql('SELECT * FROM "user" WHERE "id" = ? AND "active" = ?');
  assert.equal(formatted, 'SELECT *\nFROM "user"\nWHERE "id" = ?\n  AND "active" = ?');
});

test('formatSql leaves a query with no recognized clauses untouched', () => {
  assert.equal(formatSql('BEGIN'), 'BEGIN');
});

test('traceDuplicateCounts tallies repeats of the same category+label pair', () => {
  const events = [
    { category: 'query', label: 'SELECT 1' },
    { category: 'query', label: 'SELECT 1' },
    { category: 'query', label: 'SELECT 2' },
  ];
  const counts = traceDuplicateCounts(events);
  assert.equal(counts.get('query:SELECT 1'), 2);
  assert.equal(counts.get('query:SELECT 2'), 1);
});

test('traceDuplicateQueryCount only counts the query category, not other repeated events', () => {
  const events = [
    { category: 'query', label: 'SELECT 1' },
    { category: 'query', label: 'SELECT 1' },
    { category: 'log', label: 'cache miss' },
    { category: 'log', label: 'cache miss' },
  ];
  assert.equal(traceDuplicateQueryCount(events), 2);
});

test('traceRows only flags dupCount for the query category', () => {
  const events = [
    { category: 'query', label: 'SELECT 1', timestamp: 1000, duration: 1 },
    { category: 'query', label: 'SELECT 1', timestamp: 1001, duration: 1 },
    { category: 'log', label: 'SELECT 1', timestamp: 1002, duration: 1 },
  ];
  const rows = traceRows(events);
  assert.equal(rows[0].dupCount, 2);
  assert.equal(rows[1].dupCount, 2);
  assert.equal(rows[2].dupCount, 1);
});

test('occurrenceMarkdown includes the exception message, stack, and correlated trace', () => {
  const ev = { id: 'a', label: 'NotFoundException', status: 'error', timestamp: 0, meta: { message: 'User 1 not found', stack: 'at foo.js:1' } };
  const traceEvents = [ev, { id: 'b', category: 'query', label: 'SELECT 1', duration: 5 }];
  const md = occurrenceMarkdown(ev, 'exception', traceEvents);
  assert.ok(md.includes('# NotFoundException'));
  assert.ok(md.includes('User 1 not found'));
  assert.ok(md.includes('at foo.js:1'));
  assert.ok(md.includes('[query] SELECT 1 (5ms)'));
});

test('occurrenceMarkdown formats a query occurrence as a fenced sql block', () => {
  const ev = { id: 'a', label: 'SELECT * FROM "user" WHERE "id" = ?', status: 'ok', timestamp: 0, meta: {} };
  const md = occurrenceMarkdown(ev, 'query', []);
  assert.ok(md.includes('```sql'));
  assert.ok(md.includes('WHERE "id" = ?'));
});

test('occurrenceAiPrompt wraps occurrenceMarkdown with a debugging instruction', () => {
  const ev = { id: 'a', label: 'boom', status: 'error', timestamp: 0, meta: {} };
  const prompt = occurrenceAiPrompt(ev, 'exception', []);
  assert.ok(prompt.startsWith('Help me debug this exception failure:'));
  assert.ok(prompt.includes('# boom'));
});
