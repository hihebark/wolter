// Pure data-transformation logic shared between the dashboard's embedded
// browser script and this package's test suite. No DOM references here —
// anything that touches document/window/fetch/localStorage stays inline in
// dashboard.html.ts instead. Loaded two ways:
//   1. Node (tests): required as a normal CommonJS module.
//   2. Browser: this file's raw source text is read and prepended into the
//      dashboard's <script> block (see dashboard.html.ts) — so it must also
//      work as plain top-level function declarations with no import/export
//      syntax. The module.exports guard below only runs under Node.

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// One shared "nothing here" icon for every empty state (table/previewRows/
// eventsList) — a plain empty-tray glyph, not category-specific, so a
// zero-data state reads as designed rather than a bare line of italic text.
const EMPTY_ICON = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h5a1 1 0 0 1 1 1 3 3 0 0 0 6 0 1 1 0 0 1 1-1h5"/><path d="M3 11 5.5 5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.4L21 11v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
function emptyStateHtml(message) {
  return '<div class="empty">' + EMPTY_ICON + '<span>' + escapeHtml(message) + '</span></div>';
}

function summarize(rows) {
  const byLabel = new Map();
  for (const r of rows) {
    const s = byLabel.get(r.label) || {
      label: r.label, method: undefined, path: undefined, count: 0, errorCount: 0, slowCount: 0,
      normalCount: 0, clientErrorCount: 0, serverErrorCount: 0,
      totalDuration: 0, min: Infinity, max: 0, p50: 0, p95: 0, p99: 0,
      lastSeen: 0, firstSeen: Infinity,
    };
    // Take whichever row actually has it — a pre-upgrade row (written before route/label
    // resolution existed) has no method/path, but a later row for the same label in the
    // same merge might, and shouldn't be shadowed by an earlier null/undefined value.
    if (r.method) s.method = r.method;
    if (r.path) s.path = r.path;
    s.count += r.count;
    s.errorCount += r.errorCount;
    s.slowCount += r.slowCount;
    s.normalCount += r.normalCount;
    s.clientErrorCount += r.clientErrorCount;
    s.serverErrorCount += r.serverErrorCount;
    s.totalDuration += r.totalDuration;
    s.min = Math.min(s.min, r.min);
    s.max = Math.max(s.max, r.max);
    s.p50 = Math.max(s.p50, r.p50);
    s.p95 = Math.max(s.p95, r.p95);
    s.p99 = Math.max(s.p99, r.p99);
    s.lastSeen = Math.max(s.lastSeen, r.window);
    s.firstSeen = Math.min(s.firstSeen, r.window);
    byLabel.set(r.label, s);
  }
  return [...byLabel.values()].sort((a, b) => b.p95 - a.p95);
}

// Fallback only — a matched route's method/path come straight from the
// backend's routes table (row.method/row.path, joined in sqlite.storage.ts's
// query()). This only fires for the synthetic "(unmatched)" bucket, which
// isn't a real endpoint and so was never given a route id in the first place.
function splitLabel(label) {
  const i = label.indexOf(' ');
  return i === -1 ? { method: '', path: label } : { method: label.slice(0, i), path: label.slice(i + 1) };
}

function relativeTime(ts, now) {
  const diff = (now === undefined ? Date.now() : now) - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

const RANGE_MS = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const BUCKET_MS = 60_000;

// Presets stay "since X ago through now". A custom range picked in the
// dashboard's range-pills popover carries its own absolute bounds instead,
// encoded as 'custom:<sinceMs>:<untilMs>' — this is the one place that string
// gets decoded, everything downstream (denseWindows, bucketMsForRange) just
// works off the returned {since, until}. Mirrors sqlite.storage.ts's
// parseRange on the backend; falls back to the 1h preset on anything
// malformed rather than letting NaN bounds reach a chart.
function parseRangeBounds(range, now) {
  const nowMs = now === undefined ? Date.now() : now;
  if (typeof range === 'string' && range.startsWith('custom:')) {
    const [, sinceStr, untilStr] = range.split(':');
    const since = Number(sinceStr);
    const until = Number(untilStr);
    if (Number.isFinite(since) && Number.isFinite(until) && until > since) return { since, until };
  }
  return { since: nowMs - (RANGE_MS[range] || RANGE_MS['1h']), until: nowMs };
}

// The backend always writes 1-minute buckets (see aggregator.ts), fine up
// through 24h. 7d/30d would mean fetching AND rendering thousands of 1-minute
// bars, so those ranges group rows into coarser display buckets instead —
// client-side only, nothing about backend storage granularity changes. A
// custom range picks its bucket size off its own span using the same
// breakpoints, since it can cover anything from minutes to months.
const DISPLAY_BUCKET_MS = { '7d': 3_600_000, '30d': 21_600_000 };
function bucketMsForRange(range) {
  if (typeof range === 'string' && range.startsWith('custom:')) {
    const { since, until } = parseRangeBounds(range);
    const span = until - since;
    if (span <= RANGE_MS['24h']) return BUCKET_MS;
    if (span <= RANGE_MS['7d']) return DISPLAY_BUCKET_MS['7d'];
    return DISPLAY_BUCKET_MS['30d'];
  }
  return DISPLAY_BUCKET_MS[range] || BUCKET_MS;
}

// A dense, zero-filled list of every bucket in the range — without this, a
// chart with only 1-2 real data points spaces them evenly across the whole
// width (one giant bar) instead of at their actual position in time.
function denseWindows(range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const { since, until } = parseRangeBounds(range, now);
  const span = Math.max(step, until - since);
  const end = Math.floor(until / step) * step;
  const start = end - span + step;
  const windows = [];
  for (let t = start; t <= end; t += step) windows.push(t);
  return windows;
}

// Rows are stored at 1-minute resolution — floor each row's window down to
// the display bucket boundary before grouping, so e.g. 60 one-minute rows
// correctly collapse into a single 1-hour bar for the 7d range.
function floorWindow(window, bucketMs) { return Math.floor(window / bucketMs) * bucketMs; }

function timeSeries(rows, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const byWindow = new Map();
  for (const r of rows) {
    const w = floorWindow(r.window, step);
    byWindow.set(w, (byWindow.get(w) || 0) + r.count);
  }
  return denseWindows(range, now, step).map(window => ({ window, count: byWindow.get(window) || 0 }));
}

function statusSeries(rows, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const byWindow = new Map();
  for (const r of rows) {
    const key = floorWindow(r.window, step);
    const w = byWindow.get(key) || { normal: 0, clientError: 0, serverError: 0 };
    w.normal += r.normalCount; w.clientError += r.clientErrorCount; w.serverError += r.serverErrorCount;
    byWindow.set(key, w);
  }
  return denseWindows(range, now, step).map(window => {
    const w = byWindow.get(window) || { normal: 0, clientError: 0, serverError: 0 };
    return { window, normal: w.normal, clientError: w.clientError, serverError: w.serverError };
  });
}

function queryStatusSeries(rows, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const byWindow = new Map();
  for (const r of rows) {
    const key = floorWindow(r.window, step);
    const w = byWindow.get(key) || { ok: 0, slow: 0, error: 0 };
    w.ok += r.count - r.slowCount - r.errorCount; w.slow += r.slowCount; w.error += r.errorCount;
    byWindow.set(key, w);
  }
  return denseWindows(range, now, step).map(window => {
    const w = byWindow.get(window) || { ok: 0, slow: 0, error: 0 };
    return { window, ok: w.ok, slow: w.slow, error: w.error };
  });
}

// p50/p95/p99 merge as Math.max across sub-buckets, same approximation as
// max itself — percentiles don't combine exactly when several raw 1-minute
// buckets collapse into one coarser display bucket (7d/30d ranges), but the
// worst-sub-bucket reading is the same trade-off already made for max, and
// keeps a genuine 30d p95 trend meaningfully different from just re-plotting avg.
function durationSeries(rows, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const byWindow = new Map();
  for (const r of rows) {
    const key = floorWindow(r.window, step);
    const w = byWindow.get(key) || { totalDuration: 0, count: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    w.totalDuration += r.totalDuration; w.count += r.count; w.max = Math.max(w.max, r.max);
    w.p50 = Math.max(w.p50, r.p50); w.p95 = Math.max(w.p95, r.p95); w.p99 = Math.max(w.p99, r.p99);
    byWindow.set(key, w);
  }
  return denseWindows(range, now, step).map(window => {
    const w = byWindow.get(window);
    return {
      window, avg: w && w.count ? w.totalDuration / w.count : 0, max: w ? w.max : 0,
      p50: w ? w.p50 : 0, p95: w ? w.p95 : 0, p99: w ? w.p99 : 0,
    };
  });
}

// Runtime gauges (cpu/heap/eventLoopLag) are stored one label per metric,
// duration = the sampled value — this picks out one metric's own line
// instead of summing across labels like durationSeries does for latency.
function metricSeries(rows, label, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const matching = rows.filter(r => r.label === label);
  const byWindow = new Map();
  for (const r of matching) {
    const key = floorWindow(r.window, step);
    const w = byWindow.get(key) || { totalDuration: 0, count: 0 };
    w.totalDuration += r.totalDuration; w.count += r.count;
    byWindow.set(key, w);
  }
  return denseWindows(range, now, step).map(window => {
    const w = byWindow.get(window);
    return { window, avg: w && w.count ? w.totalDuration / w.count : 0 };
  });
}

// One item's own trend — used by the detail view opened from a table row.
// Generic across categories: count/errors/slow always mean something, avg
// duration is 0 for categories that don't track timing (e.g. jobs).
function labelSeries(rows, label, range, now, bucketMs) {
  const step = bucketMs || BUCKET_MS;
  const matching = rows.filter(r => r.label === label);
  const byWindow = new Map();
  for (const r of matching) {
    const key = floorWindow(r.window, step);
    const w = byWindow.get(key) || { count: 0, errorCount: 0, slowCount: 0, totalDuration: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    w.count += r.count; w.errorCount += r.errorCount; w.slowCount += r.slowCount;
    w.totalDuration += r.totalDuration; w.max = Math.max(w.max, r.max);
    w.p50 = Math.max(w.p50, r.p50); w.p95 = Math.max(w.p95, r.p95); w.p99 = Math.max(w.p99, r.p99);
    byWindow.set(key, w);
  }
  return denseWindows(range, now, step).map(window => {
    const w = byWindow.get(window);
    return {
      window,
      count: w ? w.count : 0,
      errorCount: w ? w.errorCount : 0,
      slowCount: w ? w.slowCount : 0,
      avg: w && w.count ? w.totalDuration / w.count : 0,
      max: w ? w.max : 0,
      p50: w ? w.p50 : 0, p95: w ? w.p95 : 0, p99: w ? w.p99 : 0,
    };
  });
}

// Inline color hints for table cells — lets a slow/error row stand out
// without reading every number, same idea as NightOwl's per-row status
// coloring. Pure/threshold-based rather than tied to any one category's own
// "slow" definition, so the same two helpers cover every table.
function durationCellClass(ms) {
  if (ms >= 1000) return 'num-critical';
  if (ms >= 300) return 'num-warn';
  return '';
}
function nonZeroClass(n, severity) {
  return n > 0 ? 'num-' + severity : '';
}

function latestMetric(rows, label) {
  const matching = rows.filter(r => r.label === label);
  if (!matching.length) return 0;
  const latest = matching.reduce((a, b) => (b.window > a.window ? b : a));
  return latest.count ? latest.totalDuration / latest.count : 0;
}

// Shared by table() and pageCount() so they can never drift out of sync.
const TABLE_PAGE_SIZE = 20;

function colClasses(c) {
  const classes = [];
  if (c.num) classes.push('num');
  if (c.mono) classes.push('mono');
  if (c.flex) classes.push('flex');
  return classes.join(' ');
}

// sort is { index, dir } (dir: 1 asc, -1 desc) or null/undefined for the
// caller's own default order (summarize()'s worst-p95-first). Only columns
// that declare a `sort` accessor become clickable — a raw-value accessor
// kept separate from `fmt` because fmt often returns display strings ("6ms")
// that don't compare correctly as plain string/number sort keys.
function table(rows, cols, page, sort, emptyMessage) {
  if (!rows.length) return emptyStateHtml(emptyMessage || 'No data yet');
  const sortedRows = sort && cols[sort.index] && cols[sort.index].sort
    ? [...rows].sort((a, b) => {
        const av = cols[sort.index].sort(a), bv = cols[sort.index].sort(b);
        return av < bv ? -sort.dir : av > bv ? sort.dir : 0;
      })
    : rows;
  const pageSize = TABLE_PAGE_SIZE;
  const p = Math.max(0, page || 0);
  const start = p * pageSize;
  const pageRows = sortedRows.slice(start, start + pageSize);
  const head = cols.map((c, i) => {
    const active = sort && sort.index === i;
    // Active column keeps a bare-text arrow (existing behavior/tests) — a
    // sortable-but-idle column gets a dim hint span instead, so it's
    // discoverable as clickable before you've ever sorted by it, not just
    // after. No indicator at all for non-sortable columns.
    const arrow = active ? (sort.dir === 1 ? ' ▲' : ' ▼') : c.sort ? ' <span class="sort-idle">⇅</span>' : '';
    const cls = colClasses(c) + (c.sort ? ' sortable' : '') + (active ? ' sorted' : '');
    return '<th class="' + cls + '"' + (c.sort ? ' data-col-index="' + i + '"' : '') + '>' + escapeHtml(c.label) + arrow + '</th>';
  }).join('');
  const body = pageRows.map(r => '<tr class="row-detail" data-label="' + escapeHtml(r.label) + '">' + cols.map(c => {
    // cellCls is optional and row-dependent (e.g. duration/count thresholds)
    // — distinct from colClasses, which is fixed per-column regardless of row.
    const cellCls = c.cellCls ? ' ' + c.cellCls(r) : '';
    return '<td class="' + colClasses(c) + cellCls + '">' + escapeHtml(c.fmt(r)) + '</td>';
  }).join('') + '</tr>').join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
}

// Compact "worst offenders" preview for a dashboard card — top 3 items,
// label on the left, one figure on the right (Nightwatch's Routes-card style).
function previewRows(items, labelFn, valueFn, emptyMessage) {
  if (!items.length) return emptyStateHtml(emptyMessage || 'No data yet');
  return '<div class="preview-list">' + items.slice(0, 3).map(r =>
    '<div class="preview-row"><span class="preview-label">' + escapeHtml(labelFn(r)) + '</span><span class="preview-value">' + escapeHtml(valueFn(r)) + '</span></div>'
  ).join('') + '</div>';
}

function pageCount(rows) {
  return Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
}

function legendHtml(labels, colors) {
  return labels.map((l, i) => '<span class="legend-item"><span class="legend-dot" style="background:' + colors[i] + '"></span>' + escapeHtml(l) + '</span>').join('');
}

// Human labels for the series keys used across renderStackedBars/renderMultiLine
// call sites, shared by their hover-tooltip text.
const KEY_LABELS = {
  normal: '1-3xx', clientError: '4xx', serverError: '5xx',
  ok: 'ok', slow: 'slow', error: 'error', count: 'count',
  avg: 'avg', max: 'max', p50: 'p50', p95: 'p95', p99: 'p99',
};

const DURATION_KEYS = new Set(['avg', 'max', 'p50', 'p95', 'p99']);

// One bucket's hover-tooltip text: timestamp + a line per series key, plus a
// total line for non-duration multi-key series (status/ok-slow-error charts).
function bucketTooltip(window, keys, values) {
  const time = new Date(window).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lines = keys.map((k, i) => (KEY_LABELS[k] || k) + ': ' + (DURATION_KEYS.has(k) ? ms(values[i]) : values[i]));
  if (keys.length > 1 && !keys.some(k => DURATION_KEYS.has(k))) lines.push('total: ' + values.reduce((a, b) => a + b, 0));
  return [time, ...lines].join('\n');
}

function ms(n) { return Math.round(n) + 'ms'; }

// Lightweight regex-based formatter — breaks a query onto multiple lines
// before its major clauses so a long query is scannable instead of one dense
// line. ponytail: not a real SQL parser, same tradeoff as normalizeQuery
// above (ponytail: regex over a real tokenizer) — upgrade only if it garbles
// real queries in practice. Only applied where the full query is already
// shown as its own block (query detail title, occurrence payload) — table
// rows stay single-line.
const SQL_CLAUSE_BREAK = /\s+(SELECT|FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|GROUP BY|ORDER BY|LIMIT|OFFSET|HAVING|UNION ALL|UNION|VALUES|SET)\s+/gi;
const SQL_BOOLEAN_BREAK = /\s+(AND|OR)\s+/gi;
function formatSql(sql) {
  return sql
    .replace(SQL_CLAUSE_BREAK, '\n$1 ')
    .replace(SQL_BOOLEAN_BREAK, '\n  $1 ')
    .trim();
}

// A labeled <pre> block for one field of an occurrence's captured payload
// (headers/body/stack/parameters) — content is caller-escaped HTML, not
// raw text, since callers sometimes need to escape before JSON.stringify-ing.
function eventBlock(title, content) {
  return '<div class="ev-block"><div class="ev-block-title">' + escapeHtml(title) + '</div><pre>' + content + '</pre></div>';
}

// The full captured payload for one occurrence — headers/body (http),
// stack (exception), or parameters (query) — each with a hint shown instead
// when the corresponding capture option was off. Lives on the dedicated
// per-occurrence page (openOccurrence in dashboard.html.ts); ev.meta carries
// whatever the watcher captured.
function occurrenceBody(ev, kind) {
  const meta = ev.meta || {};
  if (kind === 'http') {
    const blocks = [];
    if (meta.headers) blocks.push(eventBlock('Headers', escapeHtml(JSON.stringify(meta.headers, null, 2))));
    if (meta.body !== undefined) blocks.push(eventBlock('Body', escapeHtml(typeof meta.body === 'string' ? meta.body : JSON.stringify(meta.body, null, 2))));
    return blocks.length ? blocks.join('') : '<div class="ev-empty">No headers/body captured — enable capture.headers / capture.body.</div>';
  }
  if (kind === 'exception') {
    return meta.stack ? eventBlock('Stack', escapeHtml(meta.stack)) : '<div class="ev-empty">No stack trace captured.</div>';
  }
  return meta.parameters !== undefined
    ? eventBlock('Parameters', escapeHtml(JSON.stringify(meta.parameters)))
    : '<div class="ev-empty">No parameters captured — enable captureParameters on TypeORMPlugin.</div>';
}

// One dotted-leader "LABEL ........ value" row for the per-occurrence page's
// Info/Request/Events panels. valueHtml is caller-prepared (already escaped
// or deliberately raw markup, e.g. a badge span) — same convention as
// statCard elsewhere in this file.
function kvRow(label, valueHtml) {
  return '<div class="kv-row"><span class="kv-label">' + escapeHtml(label) + '</span><span class="kv-fill"></span><span class="kv-value">' + valueHtml + '</span></div>';
}

// Tallies correlated-trace events into the per-occurrence page's "Events"
// summary. Only queries/exceptions/logs are counted — those are the only
// other categories that actually carry a traceId today (see TraceContext
// usages, WolterLoggerPlugin); jobs/cache/runtime aren't correlated to a
// specific request yet, so showing a fabricated "0" for them would overstate
// what's actually tracked.
function occurrenceEventsSummaryHtml(traceEvents, anchorEventId) {
  const others = traceEvents.filter(e => e.id !== anchorEventId);
  const queries = others.filter(e => e.category === 'query');
  const exceptions = others.filter(e => e.category === 'exception');
  const logs = others.filter(e => e.category === 'log');
  const rows = [kvRow('Queries', queries.length
    ? escapeHtml(queries.length + ' total / ' + ms(queries.reduce((n, e) => n + (e.duration || 0), 0)))
    : '<span class="kv-muted">0</span>')];
  if (exceptions.length) rows.push(kvRow('Exceptions', '<span class="kv-bad">' + exceptions.length + '</span>'));
  if (logs.length) rows.push(kvRow('Logs', escapeHtml(String(logs.length))));
  return rows.join('');
}

// Round tick interval so the trace timeline's ruler shows a handful of
// labeled gridlines (e.g. 0/50/100/150ms) instead of an arbitrary fraction
// of the span like 33.33ms.
const NICE_MS_STEPS = [10, 25, 50, 100, 150, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
function niceStep(span) {
  for (const step of NICE_MS_STEPS) {
    if (span / step <= 8) return step;
  }
  return Math.ceil(span / 8 / 60000) * 60000;
}
function traceTicks(span) {
  const step = niceStep(span);
  const ticks = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);
  return ticks;
}

// How many times an identical (category, normalized label) pair repeats
// within one trace — the same signal a classic N+1 query detector uses,
// just counted rather than special-cased to any one ORM.
function traceDuplicateCounts(events) {
  const counts = new Map();
  for (const e of events) {
    const key = e.category + ':' + e.label;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Scoped to 'query' specifically (not every repeated category) — a repeated
// log line or cache hit isn't a bug the way a repeated query usually is;
// this is meant to read as "N+1 query count", not "anything happened twice".
function traceDuplicateQueryCount(events) {
  const counts = traceDuplicateCounts(events);
  return events.filter(e => e.category === 'query' && counts.get(e.category + ':' + e.label) > 1).length;
}

// Correlated events (same traceId, across http/exception/query) laid out as
// a flat waterfall: each row's bar is positioned/sized relative to the
// trace's own start and total span. No nested bootstrap/middleware tree —
// Wolter only instruments these 3 categories, so a flat list is what the
// data actually supports.
function traceRows(events) {
  if (!events.length) return [];
  const start = events[0].timestamp;
  const end = Math.max(...events.map(e => e.timestamp + (e.duration || 0)));
  const span = Math.max(1, end - start);
  const dupCounts = traceDuplicateCounts(events);
  return events.map(e => ({
    category: e.category,
    label: e.label,
    duration: e.duration || 0,
    offsetPct: ((e.timestamp - start) / span) * 100,
    widthPct: Math.max(0.6, ((e.duration || 0) / span) * 100),
    dupCount: e.category === 'query' ? dupCounts.get(e.category + ':' + e.label) : 1,
  }));
}

// The ruler row shares the same [badge][label][track][duration] flex slots
// as a real trace-row (see .trace-row CSS) so its ticks land in exactly the
// same horizontal space as the bars below — no JS pixel measurement needed,
// flexbox alone keeps every row's track at the same x-position regardless of
// each row's own badge/label width, since the flexible label always absorbs
// whatever space the fixed-width siblings don't use.
function traceRulerHtml(span) {
  const ticks = traceTicks(span);
  return '<div class="trace-row trace-ruler">' +
    '<span class="badge-status" style="visibility:hidden">exception</span>' +
    '<span class="trace-label"></span>' +
    '<span class="trace-bar-track trace-ruler-track">' +
      ticks.map(t => '<span class="trace-tick" style="left:' + ((t / span) * 100).toFixed(1) + '%">' + ms(t) + '</span>').join('') +
    '</span>' +
    '<span class="trace-duration"></span>' +
  '</div>';
}

function traceWaterfallHtml(events) {
  if (!events.length) return '<div class="ev-empty">No correlated events found.</div>';
  const start = events[0].timestamp;
  const end = Math.max(...events.map(e => e.timestamp + (e.duration || 0)));
  const span = Math.max(1, end - start);
  return '<div class="trace-waterfall">' + traceRulerHtml(span) + traceRows(events).map(r =>
    '<div class="trace-row">' +
      '<span class="badge-status ' + escapeHtml(r.category) + '">' + escapeHtml(r.category) + '</span>' +
      '<span class="trace-label" title="' + escapeHtml(r.label) + '">' + escapeHtml(r.label) +
        (r.dupCount > 1 ? ' <span class="trace-dup-badge">&times;' + r.dupCount + '</span>' : '') +
      '</span>' +
      '<span class="trace-bar-track"><span class="trace-bar-fill ' + escapeHtml(r.category) + '" style="left:' + r.offsetPct.toFixed(1) + '%;width:' + r.widthPct.toFixed(1) + '%"></span></span>' +
      '<span class="trace-duration">' + ms(r.duration) + '</span>' +
    '</div>'
  ).join('') + '</div>';
}

// One row in the detail page's "Recent Occurrences" list — a plain
// clickable summary; clicking navigates to a full per-occurrence page
// (openOccurrence in dashboard.html.ts) rather than expanding inline, since
// headers/body/stack/parameters and the correlated-trace timeline need more
// room than a list row can give. kind is 'http' | 'exception' | 'query'.
function eventRow(ev, kind) {
  const meta = ev.meta || {};
  const time = relativeTime(ev.timestamp);
  let summary;
  if (kind === 'http') {
    summary = [meta.method, meta.path, ev.statusCode, ev.duration ? ms(ev.duration) : '', time].filter(Boolean).join(' · ');
  } else if (kind === 'exception') {
    summary = [meta.message || ev.label, time].filter(Boolean).join(' · ');
  } else {
    summary = [ev.duration ? ms(ev.duration) : '', time].filter(Boolean).join(' · ');
  }
  return '<div class="ev-row" data-event-id="' + ev.id + '"><span class="ev-summary">' + escapeHtml(summary) + '</span><span class="ev-chevron">&rsaquo;</span></div>';
}

function eventsList(events, kind) {
  if (!events.length) return emptyStateHtml('No recent occurrences');
  return events.map(ev => eventRow(ev, kind)).join('');
}

// Serializes one occurrence — its own fields plus its correlated trace, if
// any — into a paste-ready markdown block. Two entry points share this body:
// a plain "Copy as Markdown" (for a ticket/PR) and "Copy AI prompt" (same
// body, wrapped with a debugging instruction) below.
function occurrenceMarkdown(ev, kind, traceEvents) {
  const meta = ev.meta || {};
  const title = kind === 'http' ? [meta.method, meta.path || ev.label].filter(Boolean).join(' ') : ev.label;
  const lines = ['# ' + title, ''];
  lines.push('- Status: ' + ev.status + (ev.statusCode !== undefined && ev.statusCode !== null ? ' (' + ev.statusCode + ')' : ''));
  if (ev.duration) lines.push('- Duration: ' + ms(ev.duration));
  lines.push('- Time: ' + new Date(ev.timestamp).toISOString());
  lines.push('');

  if (kind === 'exception') {
    if (meta.message) lines.push('**Message:** ' + meta.message, '');
    if (meta.stack) lines.push('```', meta.stack, '```');
  } else if (kind === 'query') {
    lines.push('```sql', formatSql(ev.label), '```');
    if (meta.parameters !== undefined) lines.push('', '**Parameters:** `' + JSON.stringify(meta.parameters) + '`');
  } else if (kind === 'http') {
    if (meta.headers) lines.push('**Headers:**', '```json', JSON.stringify(meta.headers, null, 2), '```', '');
    if (meta.body !== undefined) lines.push('**Body:**', '```json', typeof meta.body === 'string' ? meta.body : JSON.stringify(meta.body, null, 2), '```');
  }

  const others = (traceEvents || []).filter(e => e.id !== ev.id);
  if (others.length) {
    lines.push('', '**Correlated trace (' + others.length + ' events):**');
    others.forEach(e => lines.push('- [' + e.category + '] ' + e.label + (e.duration ? ' (' + ms(e.duration) + ')' : '')));
  }
  return lines.join('\n');
}

function occurrenceAiPrompt(ev, kind, traceEvents) {
  return 'Help me debug this ' + kind + (ev.status === 'error' ? ' failure' : '') + ':\n\n' + occurrenceMarkdown(ev, kind, traceEvents);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml, summarize, splitLabel, relativeTime, denseWindows, bucketMsForRange, parseRangeBounds,
    timeSeries, statusSeries, queryStatusSeries, durationSeries, metricSeries, latestMetric, labelSeries,
    colClasses, table, pageCount, previewRows, legendHtml, ms, durationCellClass, nonZeroClass,
    eventRow, eventsList, occurrenceBody, kvRow, occurrenceEventsSummaryHtml,
    bucketTooltip, traceRows, traceTicks, niceStep, traceWaterfallHtml,
    formatSql, traceDuplicateCounts, traceDuplicateQueryCount, occurrenceMarkdown, occurrenceAiPrompt,
  };
}
