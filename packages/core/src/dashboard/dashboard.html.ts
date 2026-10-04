// ponytail: one inline HTML/CSS/JS string, no build step, no bundler, no
// framework, no charting library — bars/lines drawn by hand in SVG, page
// switching by toggling .active classes (no router). Structure follows
// Laravel Nightwatch (sidebar nav, one page per category, segmented range
// pills, status-class breakdown charts) since that's the closer analog to
// Wolter's actual data model (aggregated buckets) than Pulse's widget style.
// Colors via the dataviz skill's method: one validated accent per theme mode,
// plus the fixed good/warning/critical status triad for the 2xx/4xx/5xx and
// ok/slow/error breakdowns — contrast-checked against these exact surfaces
// with validate_palette.js, not eyeballed.
import * as fs from 'node:fs';
import * as path from 'node:path';

// The pure data-transformation functions (summarize/timeSeries/table/etc) live
// in dashboard-logic.js — a plain JS file so it's both requireable from the
// test suite AND embeddable verbatim into the browser <script> block below,
// with one source of truth instead of a tested copy drifting from a shipped one.
const DASHBOARD_LOGIC_JS = fs.readFileSync(path.join(__dirname, 'dashboard-logic.js'), 'utf8');

export function renderDashboardHtml(activeCategories: string[] = ['http', 'exception']): string {
  const has = (category: string) => activeCategories.includes(category);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Wolter</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0a0a0c; --surface: #131316; --border: rgba(255,255,255,.07); --row-border: rgba(255,255,255,.05);
    --active-bg: rgba(255,255,255,.06); --hover: rgba(255,255,255,.04);
    --text: #f2f2f4; --text-secondary: #9a9aa2; --text-muted: #67676f;
    --accent: #9085e9; --accent-ink: #131316;
    --good: #0ca30c; --warn: #fab219; --critical: #d03b3b;
    --gridline: rgba(255,255,255,.2); --baseline: rgba(255,255,255,.38);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --page: #f9f9f7; --surface: #ffffff; --border: rgba(11,11,11,.08); --row-border: rgba(11,11,11,.06);
    --active-bg: rgba(11,11,11,.05); --hover: rgba(11,11,11,.03);
    --text: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
    --accent: #4a3aa7; --accent-ink: #ffffff;
    --good: #0ca30c; --warn: #fab219; --critical: #d03b3b;
    --gridline: rgba(11,11,11,.16); --baseline: rgba(11,11,11,.3);
  }
  * { box-sizing: border-box; }
  /* Theme-matched keyboard focus ring, replacing the browser default outline
     — :focus-visible so it only shows for keyboard/programmatic focus, not
     every mouse click. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  body {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; background: var(--page); color: var(--text);
  }
  a { color: inherit; }
  .app { display: flex; min-height: 100vh; }

  .sidebar {
    width: 220px; flex-shrink: 0; border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 18px 12px;
    position: sticky; top: 0; height: 100vh;
    transition: width 0.15s ease;
  }
  /* Collapsed: hold each nav item's icon at fixed pixel size but zero its
     text — the label is a plain text node (not a <span>), so this is the
     one-line way to hide it without restructuring every nav-item's markup. */
  .sidebar.collapsed { width: 60px; }
  .sidebar.collapsed .brand span, .sidebar.collapsed .nav-item { font-size: 0; }
  .sidebar.collapsed .nav-item { justify-content: center; padding: 8px; }
  /* Below this width the full 220px sidebar leaves too little room for
     content and forces horizontal scroll — always render icon-only here,
     same rules as .collapsed, regardless of the user's manual toggle. */
  @media (max-width: 680px) {
    .sidebar { width: 60px; }
    .sidebar .brand span, .sidebar .nav-item { font-size: 0; }
    .sidebar .nav-item { justify-content: center; padding: 8px; }
    .content { padding: 20px 16px 40px; }
    /* The collapse/expand toggle has nothing left to do here — the sidebar
       is forced icon-only regardless of the .collapsed class at this width. */
    .sidebar-toggle { display: none; }
  }
  .sidebar.collapsed .sidebar-toggle svg { transform: rotate(180deg); }
  .brand { display: flex; align-items: center; gap: 9px; padding: 4px 10px 22px; }
  .brand svg { color: var(--accent); }
  .brand span { font-weight: 600; font-size: 15px; }
  nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 8px; border-radius: 8px;
    color: var(--text-secondary); text-decoration: none; font-size: 13.5px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .nav-item svg { flex-shrink: 0; }
  .nav-item:hover { background: var(--hover); color: var(--text); }
  .nav-item.active { background: var(--active-bg); color: var(--text); font-weight: 600; border-left-color: var(--accent); }
  .nav-item.active svg { color: var(--accent); }
  .sidebar-toggle { background: none; border: none; width: 100%; text-align: left; font-family: inherit; }
  .sidebar-toggle svg { transition: transform 0.15s ease; }
  .icon-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; padding: 4px; }
  .icon-btn:hover { color: var(--text-secondary); }

  .content { flex: 1; min-width: 0; padding: 26px 32px 60px; max-width: 1600px; position: relative; }
  .initial-loading {
    position: absolute; inset: 0; z-index: 10; background: var(--page);
    display: flex; align-items: center; justify-content: center; gap: 10px;
    color: var(--text-muted); font-size: 13.5px;
  }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border);
    border-top-color: var(--accent); animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .page { display: none; }
  .page.active { display: block; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 16px; flex-wrap: wrap; }
  .page-header h1 {
    font-size: 22px; margin: 0; font-weight: 700; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .header-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .range-pills { display: flex; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 3px; gap: 2px; }
  .range-pills button {
    background: none; border: none; color: var(--text-muted); font-size: 12.5px; font-weight: 500;
    padding: 5px 13px; border-radius: 6px; cursor: pointer; font-family: inherit;
  }
  .range-pills button.active { background: var(--accent); color: var(--accent-ink); }
  .range-pills button:hover:not(.active) { color: var(--text-secondary); }
  .range-pills { position: relative; }
  .range-pills button.range-custom.active { background: var(--accent); color: var(--accent-ink); }

  /* Custom lightweight tooltip — replaces native title attrs on icon-only
     controls so timing/styling is ours instead of the browser's default
     (slow to appear, unstyleable, clipped oddly near the sidebar). Pure CSS:
     content lives in data-tooltip, shown on hover/keyboard focus via ::after. */
  [data-tooltip] { position: relative; }
  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 25;
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 4px 8px; border-radius: 6px; font-size: 11.5px; white-space: pre-line; line-height: 1.5;
    box-shadow: 0 4px 12px rgba(0,0,0,.25); opacity: 0; pointer-events: none;
    transition: opacity .1s ease;
  }
  [data-tooltip]:hover::after, [data-tooltip]:focus-visible::after { opacity: 1; }

  .refresh-controls { display: flex; align-items: center; gap: 2px; }
  .icon-btn.live-on { color: var(--accent); }
  .icon-btn.spinning svg { animation: spin 0.7s linear infinite; }

  /* The custom date-range picker — a calendar grid + plain text time inputs,
     all styled to match the dashboard's own theme, deliberately not
     <input type="date">/datetime-local: those pop the browser's own
     unstyleable native calendar widget, exactly the kind of built-in popover
     this dashboard avoids everywhere else. */
  /* position: fixed with left/top computed in JS (positionCustomPopover),
     not CSS right:0-relative-to-.range-pills — that approach only guarded
     the left edge (flipping anchor when it went off-screen) and could still
     push the *right* edge past the window on a range-pills position that
     didn't leave 268px of room either way. Viewport-clamped JS positioning
     is the only way to guarantee neither edge overflows regardless of
     window size or where the Custom button happens to sit. */
  .custom-range-popover {
    position: fixed; z-index: 30;
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.3); padding: 14px; width: 268px; max-width: calc(100vw - 24px);
  }
  .cr-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 12.5px; font-weight: 600; }
  .cr-cal-nav { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 3px 6px; border-radius: 6px; display: flex; }
  .cr-cal-nav:hover { background: var(--hover); color: var(--text); }
  .cr-cal-weekdays, .cr-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); }
  .cr-cal-weekdays { text-align: center; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .3px; margin-bottom: 2px; }
  .cr-day {
    background: none; border: none; color: var(--text); font-size: 12px; font-family: inherit;
    padding: 6px 0; cursor: pointer; border-radius: 6px; text-align: center;
    /* repeat(7, 1fr) is really repeat(7, minmax(auto, 1fr)) — without this,
       a <button>'s own intrinsic minimum width (browser default, well above
       its actual "12/34/etc" text content) floors every track at that size
       instead of the 1fr equal-share, so all 7 columns end up wider than
       the grid's own container and the last column (Saturdays) renders
       outside the popover entirely. min-width: 0 is the standard fix for
       "grid/flex item won't shrink below its content" in exactly this shape. */
    min-width: 0;
  }
  .cr-day:hover:not(:disabled) { background: var(--hover); }
  .cr-day:disabled { color: var(--text-muted); opacity: .35; cursor: default; }
  .cr-day.in-range { background: color-mix(in srgb, var(--accent) 16%, transparent); border-radius: 0; }
  .cr-day.range-start { border-radius: 6px 0 0 6px; }
  .cr-day.range-end { border-radius: 0 6px 6px 0; }
  .cr-day.range-start, .cr-day.range-end { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .cr-day.range-start.range-end { border-radius: 6px; }
  .cr-time-row { display: flex; gap: 8px; margin-top: 10px; }
  .cr-time-row > div { flex: 1; min-width: 0; }
  .cr-time-row label { display: block; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px; margin-bottom: 4px; }
  .cr-time-row input {
    width: 100%; background: var(--page); border: 1px solid var(--border); border-radius: 6px; color: var(--text);
    padding: 6px 8px; font-size: 12.5px; font-family: inherit;
  }
  .cr-time-row input:focus { outline: none; border-color: var(--accent); }
  .custom-range-error { color: var(--critical); font-size: 11.5px; margin-top: 8px; min-height: 14px; }
  .custom-range-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .custom-range-actions button { font-family: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); }
  .custom-range-actions .cr-cancel { background: none; color: var(--text-secondary); }
  .custom-range-actions .cr-apply { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }

  .search-box.has-value input { padding-right: 26px; }
  .search-box .search-clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none;
    color: var(--text-muted); cursor: pointer; display: none; padding: 2px; line-height: 0;
  }
  .search-box .search-clear:hover { color: var(--text); }
  .search-box.has-value .search-clear { display: block; }

  /* Dims the active page during a range/search refetch — not shown on the
     very first load, that's #initial-loading's job. */
  /* A breathing pulse rather than a flat dim — reads as "still loading"
     instead of "disabled". Lighter-weight than a full skeleton (placeholder
     shapes matching each chart/table's geometry) while still signaling
     motion, not just an inert lowered-opacity state. */
  @keyframes content-pulse { 0%, 100% { opacity: .55; } 50% { opacity: .8; } }
  .content.is-refreshing .page.active { animation: content-pulse 1.1s ease-in-out infinite; pointer-events: none; }

  .prod-warning {
    display: flex; align-items: center; gap: 10px; margin-bottom: 20px; padding: 10px 14px;
    border-radius: 8px; background: color-mix(in srgb, var(--warn) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn); font-size: 13px;
  }
  .prod-warning svg { flex-shrink: 0; }

  /* Dashboard overview */
  .overview-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; margin-bottom: 24px; }
  .overview-cards.runtime-group { margin-bottom: 16px; }
  .mini-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  /* Lift only the cards that actually link somewhere ("View all →") — the
     runtime CPU/Heap/Lag cards aren't clickable as a whole, so they keep the
     flat resting state rather than implying an interaction that isn't there. */
  .mini-card:has(.mini-card-head a[data-page]) { transition: transform .12s ease, box-shadow .12s ease; }
  .mini-card:has(.mini-card-head a[data-page]):hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.22); }
  .mini-card-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 4px; }
  .mini-card-head svg { color: var(--text-muted); flex-shrink: 0; }
  .mini-card-head h2 { font-size: 13.5px; margin: 0; font-weight: 600; flex: 1; }
  .mini-card-head a { font-size: 11.5px; color: var(--text-muted); text-decoration: none; cursor: pointer; }
  .mini-card-head a:hover { color: var(--accent); }
  .mini-card-value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .narrative { padding: 2px 16px 12px; font-size: 15px; font-weight: 600; line-height: 1.4; }
  .narrative .accent { color: var(--accent); }
  .narrative .bad { color: var(--critical); }
  .preview-list { border-top: 1px solid var(--row-border); }
  .preview-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 7px 16px; font-size: 12.5px; border-top: 1px solid var(--row-border);
  }
  .preview-row:first-child { border-top: none; }
  .preview-label { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview-value { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .spark-wrap { padding: 4px 16px 6px; }
  .sparkline, .chart-svg { display: block; }
  .chart-svg { cursor: crosshair; transition: opacity .15s ease; }
  .chart-select-box { fill: var(--accent); fill-opacity: .18; stroke: var(--accent); stroke-width: 1; pointer-events: none; }

  /* Custom hover tooltip for chart hit-targets — replaces the native SVG
     <title> popup (slow to appear, unstyleable, browser-chrome look) with
     something themed and instant, same rationale as [data-tooltip] above.
     One shared element, positioned in JS per-hover rather than one per bar. */
  .chart-tooltip {
    position: fixed; z-index: 50; pointer-events: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 11.5px; line-height: 1.6; color: var(--text);
    box-shadow: 0 4px 16px rgba(0,0,0,.3); white-space: pre-line; max-width: 240px;
    opacity: 0; transition: opacity .08s ease;
  }
  .chart-tooltip.visible { opacity: 1; }
  .hit-target { fill: transparent; cursor: crosshair; }

  /* Detail pages */
  .detail-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 8px; }
  @media (max-width: 880px) { .detail-cards { grid-template-columns: 1fr; } }
  .detail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px 14px; }
  .dc-head { display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; margin-bottom: 2px; }
  .dc-title { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-muted); font-weight: 600; }
  .dc-stat { display: flex; align-items: baseline; gap: 5px; }
  .dc-stat .n { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .dc-stat.normal .n { color: var(--text-secondary); }
  .dc-stat.warn .n { color: var(--warn); }
  .dc-stat.critical .n { color: var(--critical); }
  .dc-stat .u { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .3px; }
  .dm-toggle { display: flex; gap: 2px; background: var(--page); border: 1px solid var(--border); border-radius: 7px; padding: 2px; width: fit-content; margin-top: 4px; }
  .dm-toggle button {
    background: none; border: none; color: var(--text-muted); font-size: 11px; font-weight: 500;
    padding: 3px 9px; border-radius: 5px; cursor: pointer; font-family: inherit;
  }
  .dm-toggle button.active { background: var(--accent); color: var(--accent-ink); }
  .dm-toggle button:hover:not(.active) { color: var(--text-secondary); }
  .legend { display: flex; gap: 14px; margin: 6px 0 4px; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .3px; }
  .legend-dot { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
  /* Same dot used standalone in .legend rows, and inline on a .dc-stat pill
     (next rule) — ties each stat number to its exact chart-segment color
     without a second, redundant legend row repeating numbers already here. */
  .dc-stat .legend-dot { margin-right: 1px; }

  .table-toolbar { display: flex; align-items: center; justify-content: space-between; margin: 26px 0 10px; }
  .table-toolbar h3 { font-size: 14px; margin: 0; font-weight: 600; }
  .search-box { position: relative; }
  .search-box svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
  .search-box input {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
    padding: 6px 10px 6px 30px; font-size: 12.5px; font-family: inherit; width: 220px;
  }
  .search-box input:focus { outline: none; border-color: var(--accent); }
  .table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; overflow-y: hidden; }
  .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; }
  .pagination span { font-size: 12px; color: var(--text-muted); }
  .pagination button {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary);
    padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .pagination button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
  .pagination button:disabled { opacity: .4; cursor: default; }

  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 8px 18px; font-size: 12.5px; vertical-align: top; }
  th {
    color: var(--text-muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; white-space: nowrap;
    position: sticky; top: 0; background: var(--surface); z-index: 2;
  }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text-secondary); }
  th.sorted { color: var(--accent); }
  .sort-idle { font-size: 9px; opacity: .4; }
  th.sortable:hover .sort-idle { opacity: .8; }
  td:not(.mono), th:not(.mono) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.flex, th.flex { max-width: 0; width: 100%; }
  tbody tr { border-top: 1px solid var(--row-border); }
  tbody tr:hover { background: var(--hover); }
  tbody tr.row-detail { cursor: pointer; }

  /* Overrides the sidebar's generic nav{flex-direction:column} rule below -- this nav is a single row. */
  .detail-breadcrumb {
    display: flex; flex-direction: row; flex: none; align-items: center; gap: 6px; margin-bottom: 12px; font-size: 13px; min-width: 0;
  }
  .detail-back {
    display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted);
    text-decoration: none; cursor: pointer; flex-shrink: 0;
  }
  .detail-back:hover { color: var(--text); }
  .crumb-sep { color: var(--text-muted); flex-shrink: 0; }
  .crumb-link { color: var(--text-muted); text-decoration: none; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .crumb-link:hover { color: var(--text); }
  #page-detail h1 { font-size: 20px; margin: 0 0 18px; word-break: break-word; }
  #page-detail h1.mono-title {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; font-weight: 500;
    line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap;
  }

  /* Detail page's per-item stat row (count/min/p50/.../last seen) as actual
     card tiles instead of a bare dotted inline row — each figure gets its
     own visual boundary, matching the dashboard overview's mini-card
     language rather than reusing .dc-stat (that one's for the two-per-row
     Requests/Duration summary cards further down, a different density). */
  .stat-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat-card .n { display: block; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-card .n.critical { color: var(--critical); }
  .stat-card .n.warn { color: var(--warn); }
  .stat-card .u { display: block; font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px; margin-top: 2px; }
  .badge-method {
    display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600;
    padding: 3px 9px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border);
    color: var(--text-secondary); vertical-align: middle; margin-right: 10px;
  }
  .badge-status {
    display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
    padding: 3px 9px; border-radius: 6px; vertical-align: middle; margin-right: 10px;
  }
  .badge-status.critical, .badge-status.exception { background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); }
  .badge-status.good { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
  .badge-status.http { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .badge-status.query { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .badge-status.log { background: color-mix(in srgb, var(--text-muted) 16%, transparent); color: var(--text-secondary); }

  /* Per-occurrence page header: path first (grows), method chip pinned to
     the end — mirrors the breadcrumb below it, which reads outer-to-inner
     left-to-right, so the one piece of info that's specific to *this*
     request (its method) reads last, like a qualifier. */
  .occurrence-header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  .occurrence-header .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 20px; font-weight: 600; word-break: break-word; min-width: 0; white-space: pre-wrap; }
  .occurrence-header-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .occ-actions { display: flex; gap: 8px; }
  .occ-copy-btn {
    font-family: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border); background: none; color: var(--text-secondary);
  }
  .occ-copy-btn:hover { color: var(--text); border-color: var(--text-muted); }
  .trace-dup-badge { color: var(--warn); font-weight: 700; font-size: 11px; }
  .badge-method-chip {
    display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: 0.03em;
    padding: 3px 10px; border-radius: 6px; flex-shrink: 0;
    background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* Dotted-leader "LABEL ........ value" rows for the occurrence page's
     Info/Request/Events panels. */
  .kv-row { display: flex; align-items: baseline; gap: 8px; padding: 6px 0; font-size: 12.5px; }
  .kv-label { color: var(--text-muted); text-transform: uppercase; font-size: 10.5px; letter-spacing: .4px; flex-shrink: 0; }
  .kv-fill { flex: 1; border-bottom: 1px dotted var(--row-border); margin-bottom: 4px; min-width: 20px; }
  .kv-value { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv-muted { color: var(--text-muted); }
  .kv-bad { color: var(--critical); font-weight: 600; }

  .ev-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    border-top: 1px solid var(--row-border); padding: 10px 2px; font-size: 13px;
    color: var(--text); cursor: pointer;
  }
  .ev-row:first-child { border-top: none; }
  .ev-row:hover { background: var(--hover); }
  .ev-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ev-chevron { color: var(--text-muted); flex-shrink: 0; font-size: 16px; }
  .ev-block { margin: 10px 0 0; }
  .ev-block-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 4px; }
  .ev-block pre {
    background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  }
  .ev-empty { color: var(--text-muted); font-size: 12px; margin: 10px 0 0; }
  .trace-waterfall { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .trace-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .trace-label {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  /* flex:1 (not a fixed px width) so the timeline spans the available card
     width like a real gantt chart — the ruler row shares this exact same
     [badge][label][track][duration] slot structure, which is what keeps its
     ticks aligned under the bars with no JS pixel measurement needed. */
  .trace-bar-track { position: relative; flex: 1; min-width: 60px; height: 6px; background: var(--surface); border-radius: 3px; }
  .trace-bar-fill { position: absolute; top: 0; height: 100%; border-radius: 3px; background: var(--accent); }
  .trace-bar-fill.exception { background: var(--critical); }
  .trace-bar-fill.query { background: var(--warn); }
  .trace-bar-fill.log { background: var(--text-muted); }
  .trace-duration { width: 48px; text-align: right; color: var(--text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .trace-ruler { padding-bottom: 6px; margin-bottom: 2px; border-bottom: 1px solid var(--row-border); }
  .trace-ruler-track { height: 14px; background: none; }
  .trace-tick { position: absolute; top: 0; font-size: 10px; color: var(--text-muted); white-space: nowrap; }
  .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); font-weight: 500; white-space: nowrap; }
  .num-warn { color: var(--warn); }
  .num-critical { color: var(--critical); }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-secondary);
    white-space: normal; word-break: break-word;
  }
  .empty {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    color: var(--text-muted); padding: 28px 18px; font-size: 13px; text-align: center;
  }
  .empty svg { opacity: .5; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.ok { background: var(--good); } .dot.bad { background: var(--critical); }
  .last-updated { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2 8 4-16 2 8h8"/></svg>
      <span>Wolter</span>
    </div>
    <nav>
      <a class="nav-item active" data-page="dashboard">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Dashboard
      </a>
      <a class="nav-item" data-page="requests">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        Requests
      </a>
      ${has('query') ? `<a class="nav-item" data-page="queries">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>
        Queries
      </a>` : ''}
      <a class="nav-item" data-page="exceptions">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        Exceptions
      </a>
      ${has('job') ? `<a class="nav-item" data-page="jobs">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        Jobs
      </a>` : ''}
      ${has('cache') ? `<a class="nav-item" data-page="cache">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        Cache
      </a>` : ''}
    </nav>
    <button class="nav-item sidebar-toggle" id="sidebar-toggle" data-tooltip="Collapse sidebar" aria-label="Collapse sidebar">
      <svg id="sidebar-toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>
      Collapse
    </button>
  </aside>

  <div class="content">
    <div id="initial-loading" class="initial-loading"><span class="spinner"></span>Loading dashboard…</div>
    <div class="page-header">
      <h1 id="page-title">Dashboard</h1>
      <div class="header-tools">
        <div class="range-pills">
          <button data-range="1h" class="range-pill-preset active">1H</button>
          <button data-range="6h" class="range-pill-preset">6H</button>
          <button data-range="24h" class="range-pill-preset">24H</button>
          <button data-range="7d" class="range-pill-preset">7D</button>
          <button data-range="30d" class="range-pill-preset">30D</button>
          <button id="range-custom-btn" class="range-custom" data-tooltip="Pick a custom date range" aria-haspopup="true" aria-expanded="false">Custom</button>
          <div class="custom-range-popover" id="custom-range-popover" hidden>
            <div class="cr-cal-header">
              <button type="button" class="cr-cal-nav" id="cr-cal-prev" aria-label="Previous month">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <span id="cr-cal-month"></span>
              <button type="button" class="cr-cal-nav" id="cr-cal-next" aria-label="Next month">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </button>
            </div>
            <div class="cr-cal-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
            <div class="cr-cal-grid" id="cr-cal-grid"></div>
            <div class="cr-time-row">
              <div>
                <label for="custom-range-from-time">Start time</label>
                <input type="time" id="custom-range-from-time">
              </div>
              <div>
                <label for="custom-range-to-time">End time</label>
                <input type="time" id="custom-range-to-time">
              </div>
            </div>
            <div class="custom-range-error" id="custom-range-error"></div>
            <div class="custom-range-actions">
              <button type="button" class="cr-cancel" id="custom-range-cancel">Cancel</button>
              <button type="button" class="cr-apply" id="custom-range-apply">Apply</button>
            </div>
          </div>
        </div>
        <span id="last-updated" class="last-updated"></span>
        <div class="refresh-controls">
          <button class="icon-btn" id="live-toggle" data-tooltip="Pause live refresh">
            <svg id="live-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </button>
          <button class="icon-btn" id="refresh-now" data-tooltip="Refresh now">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
        <span id="health" data-tooltip="storage"><span class="dot"></span></span>
        <span id="plugins-health" data-tooltip="plugins" style="display:none"><span class="dot"></span></span>
        <button class="icon-btn" id="theme-toggle" data-tooltip="Toggle theme" aria-label="Toggle light/dark theme">
          <svg id="theme-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
        </button>
      </div>
    </div>

    <div id="prod-sqlite-warning" class="prod-warning" style="display:none">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Wolter is running with its SQLite storage driver in production (NODE_ENV=production). SQLite is single-file, single-instance — fine for one dev/staging replica, but consider whether that fits a production deployment.
    </div>

    <section id="page-dashboard" class="page active">
      ${has('runtime') ? `<div class="overview-cards runtime-group">
        <section class="mini-card">
          <div class="mini-card-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
            <h2>CPU</h2><span class="mini-card-value" id="ov-cpu">0%</span>
          </div>
          <div class="spark-wrap"><svg class="sparkline" id="ov-cpu-spark" width="100%" height="42"></svg></div>
        </section>
        <section class="mini-card">
          <div class="mini-card-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l3 6-9 12L3 9Z"/></svg>
            <h2>Heap</h2><span class="mini-card-value" id="ov-heap">0MB</span>
          </div>
          <div class="spark-wrap"><svg class="sparkline" id="ov-heap-spark" width="100%" height="42"></svg></div>
        </section>
        <section class="mini-card">
          <div class="mini-card-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            <h2>Event Loop Lag</h2><span class="mini-card-value" id="ov-lag">0ms</span>
          </div>
          <div class="spark-wrap"><svg class="sparkline" id="ov-lag-spark" width="100%" height="42"></svg></div>
        </section>
      </div>` : ''}
      <div class="stat-cards" id="stats"></div>
      <div class="overview-cards">
        <section class="mini-card">
          <div class="mini-card-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            <h2>Last requests</h2><a data-page="requests">View all &rarr;</a>
          </div>
          <div class="narrative" id="ov-http-narrative"></div>
          <div id="ov-http-preview"></div>
        </section>
        ${has('query') ? `<section class="mini-card">
          <div class="mini-card-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>
            <h2>Last queries</h2><a data-page="queries">View all &rarr;</a>
          </div>
          <div class="narrative" id="ov-queries-narrative"></div>
          <div id="ov-queries-preview"></div>
        </section>` : ''}
      </div>
    </section>

    <section id="page-requests" class="page">
      <div class="detail-cards">
        <div class="detail-card">
          <div class="dc-head">
            <span class="dc-title">Requests</span>
            <span class="dc-stat"><span class="n" id="req-total">0</span><span class="u">total</span></span>
            <span class="dc-stat normal"><span class="legend-dot" style="background:var(--text-muted)"></span><span class="n" id="req-normal">0</span><span class="u">1-3xx</span></span>
            <span class="dc-stat warn"><span class="legend-dot" style="background:var(--warn)"></span><span class="n" id="req-4xx">0</span><span class="u">4xx</span></span>
            <span class="dc-stat critical"><span class="legend-dot" style="background:var(--critical)"></span><span class="n" id="req-5xx">0</span><span class="u">5xx</span></span>
          </div>
          <svg class="chart-svg" id="req-status-chart" width="100%" height="140"></svg>
        </div>
        <div class="detail-card">
          <div class="dc-head">
            <span class="dc-title">Duration</span>
            <span class="dc-stat"><span class="n" id="req-avg">0ms</span><span class="u">avg</span></span>
            <span class="dc-stat warn"><span class="n" id="req-max">0ms</span><span class="u">max</span></span>
          </div>
          <div class="dm-toggle" data-dm-key="requests">
            <button type="button" class="active" data-metric="avgmax">Avg/Max</button>
            <button type="button" data-metric="p50">P50</button>
            <button type="button" data-metric="p95">P95</button>
            <button type="button" data-metric="p99">P99</button>
          </div>
          <div class="legend" id="req-duration-legend"></div>
          <svg class="chart-svg" id="req-duration-chart" width="100%" height="140"></svg>
        </div>
      </div>
      <div class="table-toolbar">
        <h3 id="req-count">0 routes</h3>
        <div class="search-box" data-search-key="requests">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="req-search" placeholder="Search routes">
          <button type="button" class="search-clear" aria-label="Clear search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="table-card"><div id="requests-table"></div></div>
      <div class="pagination" id="req-pagination"></div>
    </section>

    ${has('query') ? `<section id="page-queries" class="page">
      <div class="detail-cards">
        <div class="detail-card">
          <div class="dc-head">
            <span class="dc-title">Queries</span>
            <span class="dc-stat"><span class="n" id="q-total">0</span><span class="u">total</span></span>
            <span class="dc-stat normal"><span class="legend-dot" style="background:var(--text-muted)"></span><span class="n" id="q-ok">0</span><span class="u">ok</span></span>
            <span class="dc-stat warn"><span class="legend-dot" style="background:var(--warn)"></span><span class="n" id="q-slow">0</span><span class="u">slow</span></span>
            <span class="dc-stat critical"><span class="legend-dot" style="background:var(--critical)"></span><span class="n" id="q-error">0</span><span class="u">error</span></span>
          </div>
          <svg class="chart-svg" id="q-status-chart" width="100%" height="140"></svg>
        </div>
        <div class="detail-card">
          <div class="dc-head">
            <span class="dc-title">Duration</span>
            <span class="dc-stat"><span class="n" id="q-avg">0ms</span><span class="u">avg</span></span>
            <span class="dc-stat warn"><span class="n" id="q-max">0ms</span><span class="u">max</span></span>
          </div>
          <div class="dm-toggle" data-dm-key="queries">
            <button type="button" class="active" data-metric="avgmax">Avg/Max</button>
            <button type="button" data-metric="p50">P50</button>
            <button type="button" data-metric="p95">P95</button>
            <button type="button" data-metric="p99">P99</button>
          </div>
          <div class="legend" id="q-duration-legend"></div>
          <svg class="chart-svg" id="q-duration-chart" width="100%" height="140"></svg>
        </div>
      </div>
      <div class="table-toolbar">
        <h3 id="q-count">0 queries</h3>
        <div class="search-box" data-search-key="queries">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="q-search" placeholder="Search queries">
          <button type="button" class="search-clear" aria-label="Clear search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="table-card"><div id="queries-table"></div></div>
      <div class="pagination" id="q-pagination"></div>
    </section>` : ''}

    <section id="page-exceptions" class="page">
      <div class="detail-cards">
        <div class="detail-card" style="grid-column: 1 / -1">
          <div class="dc-head">
            <span class="dc-title">Exceptions</span>
            <span class="dc-stat"><span class="n" id="exc-total">0</span><span class="u">total</span></span>
            <span class="dc-stat normal"><span class="legend-dot" style="background:var(--text-muted)"></span><span class="n" id="exc-handled">0</span><span class="u">handled</span></span>
            <span class="dc-stat critical"><span class="legend-dot" style="background:var(--critical)"></span><span class="n" id="exc-unhandled">0</span><span class="u">unhandled</span></span>
          </div>
          <div class="narrative" id="exc-narrative"></div>
          <svg class="chart-svg" id="exc-chart" width="100%" height="120"></svg>
        </div>
      </div>
      <div class="table-toolbar">
        <h3 id="exc-count">0 exception types</h3>
        <div class="search-box" data-search-key="exceptions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="exc-search" placeholder="Search exceptions">
          <button type="button" class="search-clear" aria-label="Clear search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="table-card"><div id="exceptions-table"></div></div>
      <div class="pagination" id="exc-pagination"></div>
    </section>

    ${has('job') ? `<section id="page-jobs" class="page">
      <div class="detail-cards">
        <div class="detail-card" style="grid-column: 1 / -1">
          <div class="dc-head">
            <span class="dc-title">Jobs</span>
            <span class="dc-stat"><span class="n" id="jobs-total">0</span><span class="u">total</span></span>
            <span class="dc-stat normal"><span class="legend-dot" style="background:var(--text-muted)"></span><span class="n" id="jobs-ok">0</span><span class="u">completed</span></span>
            <span class="dc-stat warn"><span class="legend-dot" style="background:var(--warn)"></span><span class="n" id="jobs-stalled">0</span><span class="u">stalled</span></span>
            <span class="dc-stat critical"><span class="legend-dot" style="background:var(--critical)"></span><span class="n" id="jobs-failed">0</span><span class="u">failed</span></span>
          </div>
          <svg class="chart-svg" id="jobs-status-chart" width="100%" height="140"></svg>
        </div>
      </div>
      <div class="table-toolbar">
        <h3 id="jobs-count">0 queues</h3>
        <div class="search-box" data-search-key="jobs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="jobs-search" placeholder="Search queues">
          <button type="button" class="search-clear" aria-label="Clear search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="table-card"><div id="jobs-table"></div></div>
      <div class="pagination" id="jobs-pagination"></div>
    </section>` : ''}

    ${has('cache') ? `<section id="page-cache" class="page">
      <div class="detail-cards">
        <div class="detail-card" style="grid-column: 1 / -1">
          <div class="dc-head">
            <span class="dc-title">Cache</span>
            <span class="dc-stat"><span class="n" id="cache-total">0</span><span class="u">total</span></span>
            <span class="dc-stat normal"><span class="legend-dot" style="background:var(--text-muted)"></span><span class="n" id="cache-hits">0</span><span class="u">hits</span></span>
            <span class="dc-stat warn"><span class="legend-dot" style="background:var(--warn)"></span><span class="n" id="cache-misses">0</span><span class="u">misses</span></span>
            <span class="dc-stat"><span class="n" id="cache-hit-rate">0%</span><span class="u">hit rate</span></span>
          </div>
          <svg class="chart-svg" id="cache-chart" width="100%" height="140"></svg>
        </div>
      </div>
      <div class="table-toolbar">
        <h3 id="cache-count">0 key patterns</h3>
        <div class="search-box" data-search-key="cache">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="cache-search" placeholder="Search keys">
          <button type="button" class="search-clear" aria-label="Clear search"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="table-card"><div id="cache-table"></div></div>
      <div class="pagination" id="cache-pagination"></div>
    </section>` : ''}

    <section id="page-detail" class="page">
      <nav class="detail-breadcrumb">
        <a class="detail-back" id="detail-back" href="#">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
          <span id="detail-back-label">Back</span>
        </a>
      </nav>
      <h1 id="detail-title"></h1>
      <div class="stat-cards" id="detail-stats"></div>
      <div class="detail-cards">
        <div class="detail-card">
          <div class="dc-head"><span class="dc-title">Volume</span></div>
          <svg class="chart-svg" id="detail-volume-chart" width="100%" height="140"></svg>
        </div>
        <div class="detail-card">
          <div class="dc-head"><span class="dc-title">Duration</span></div>
          <div class="dm-toggle" data-dm-key="detail">
            <button type="button" class="active" data-metric="avgmax">Avg/Max</button>
            <button type="button" data-metric="p50">P50</button>
            <button type="button" data-metric="p95">P95</button>
            <button type="button" data-metric="p99">P99</button>
          </div>
          <div class="legend" id="detail-duration-legend"></div>
          <svg class="chart-svg" id="detail-duration-chart" width="100%" height="140"></svg>
        </div>
      </div>
      <div class="detail-card" id="detail-occurrences" style="margin-top: 16px">
        <div class="dc-head"><span class="dc-title">Recent Occurrences</span></div>
        <div class="range-pills" id="detail-events-filter" style="display:none; margin-bottom: 12px">
          <button type="button" class="active" data-min="0">All</button>
          <button type="button" data-min="avg">&ge; Avg</button>
          <button type="button" data-min="p50">&ge; P50</button>
          <button type="button" data-min="p95">&ge; P95</button>
          <button type="button" data-min="p99">&ge; P99</button>
        </div>
        <div id="detail-events-list"></div>
      </div>
    </section>

    <section id="page-occurrence" class="page">
      <nav class="detail-breadcrumb">
        <a class="crumb-link" id="occurrence-crumb-page" href="#"></a>
        <span class="crumb-sep">&rsaquo;</span>
        <a class="crumb-link" id="occurrence-crumb-label" href="#"></a>
      </nav>
      <div class="occurrence-header">
        <span class="path" id="occurrence-path"></span>
        <div class="occurrence-header-right">
          <div class="occ-actions" id="occ-actions" style="display:none">
            <button type="button" class="occ-copy-btn" id="occ-copy-md" data-tooltip="Copy this occurrence as markdown">Copy as Markdown</button>
            <button type="button" class="occ-copy-btn" id="occ-copy-ai" data-tooltip="Copy a debugging prompt for an AI assistant">Copy AI prompt</button>
          </div>
          <span class="badge-method-chip" id="occurrence-method"></span>
        </div>
      </div>
      <div class="detail-cards">
        <div class="detail-card">
          <div class="dc-head"><span class="dc-title">Info</span></div>
          <div id="occurrence-info"></div>
        </div>
        <div class="detail-card">
          <div class="dc-head"><span class="dc-title">Events</span></div>
          <div id="occurrence-events-summary"></div>
        </div>
      </div>
      <div class="detail-card" id="occurrence-payload-card" style="margin-top: 16px">
        <div class="dc-head"><span class="dc-title">Payload</span></div>
        <div id="occurrence-payload"></div>
      </div>
      <div class="detail-card" id="occurrence-timeline-card" style="margin-top: 16px">
        <div class="dc-head">
          <span class="dc-title">Timeline</span>
          <span class="dc-stat warn" id="occ-timeline-dupes" style="display:none"><span class="n"></span><span class="u">duplicate queries</span></span>
        </div>
        <div id="occurrence-timeline"></div>
      </div>
    </section>
  </div>
</div>
<div class="chart-tooltip" id="chart-tooltip"></div>

<script>
${DASHBOARD_LOGIC_JS}
const ICONS = {
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-icon').innerHTML = theme === 'light' ? ICONS.moon : ICONS.sun;
}
applyTheme(localStorage.getItem('wolter-theme') || 'dark');
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('wolter-theme', next);
  applyTheme(next);
});

function applySidebar(collapsed) {
  document.querySelector('.sidebar').classList.toggle('collapsed', collapsed);
  const btn = document.getElementById('sidebar-toggle');
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn.dataset.tooltip = label;
  btn.setAttribute('aria-label', label);
}
applySidebar(localStorage.getItem('wolter-sidebar-collapsed') === '1');
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const next = !document.querySelector('.sidebar').classList.contains('collapsed');
  localStorage.setItem('wolter-sidebar-collapsed', next ? '1' : '0');
  applySidebar(next);
});

// Derived from the page's own URL, not baked in server-side — a host app's
// global prefix (setGlobalPrefix), URI versioning, or reverse-proxy rewrite
// can all change the effective mount path in ways this controller has no
// way to know about ahead of time. window.location.pathname is always right.
const API = window.location.pathname.replace(/\\/$/, '');
let range = '1h';
let lastLoadTs = 0;
const RANGE_LABEL = { '1h': 'past hour', '6h': 'past 6 hours', '24h': 'past 24 hours', '7d': 'past 7 days', '30d': 'past 30 days' };
// Named "data", not "cache" — the Cache *category* already needs that word for its own key.
let data = { http: [], queries: [], exceptions: [], jobs: [], cache: [], runtime: [], health: { ok: true } };
// null = no active search, use the unfiltered cache above for the table too.
// Non-null = rows already filtered server-side for the current search term.
let tableRows = { requests: null, queries: null, exceptions: null, jobs: null, cache: null };
let pageState = { requests: 0, queries: 0, exceptions: 0, jobs: 0, cache: 0 };
// null = each table's own default order (summarize()'s worst-p95-first).
let sortState = { requests: null, queries: null, exceptions: null, jobs: null, cache: null };

// Discovered from the DOM rather than hardcoded — the server only renders
// markup for categories with a registered plugin (see WolterModule.forRoot's
// activeCategories), so this naturally reflects whatever's actually provisioned.
const PAGES = ['dashboard', 'requests', 'queries', 'exceptions', 'jobs', 'cache', 'detail', 'occurrence'].filter(id => document.getElementById('page-' + id));
const PAGE_TITLES = { dashboard: 'Dashboard', requests: 'Requests', queries: 'Queries', exceptions: 'Exceptions', jobs: 'Jobs', cache: 'Cache', detail: '', occurrence: '' };
// Where "Back" on the detail page returns to — set right before navigating there.
let detailReturnPage = 'dashboard';
// Which item the detail page is currently showing — lets the Duration
// chart's P50/P95/P99 toggle re-render in place (openItemDetail is
// idempotent against already-loaded data) without a re-fetch or losing scroll.
let currentDetailContext = { tableId: null, label: null };
// The "Recent Occurrences" list's own filter state — set by openItemDetail,
// read by renderFilteredEvents. currentDetailEvents holds the full fetched
// set (the /api/events response, capped at 50 by the backend); the ≥Avg/P50/
// P95/P99 pills filter that in place rather than re-fetching, since the
// duration thresholds to filter by (stats.p50/p95/p99) are already known
// from the same aggregate data the detail page's own stat cards use.
let currentDetailEvents = [];
let currentDetailThresholds = null;
let currentDetailFilterMin = '0';

function showPage(page) {
  if (!PAGES.includes(page)) page = 'dashboard';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + page));
  const pageTitleEl = document.getElementById('page-title');
  pageTitleEl.textContent = PAGE_TITLES[page];
  pageTitleEl.removeAttribute('title'); // clear any stale detail-page tooltip
  history.replaceState(null, '', '#' + page);
}
document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', (e) => { e.preventDefault(); showPage(el.dataset.page); });
});

// The detail page's hash carries which item it's showing (#detail/<tableId>/<label>);
// the occurrence page additionally carries which specific event
// (#occurrence/<tableId>/<eventId>/<encodedLabel>) — so a refresh or a shared
// link can restore either instead of landing on an empty page.
function parseHash() {
  const raw = location.hash.replace('#', '');
  if (raw.startsWith('detail/')) {
    const [, tableId, encodedLabel] = raw.split('/');
    return { page: 'detail', tableId, label: encodedLabel ? decodeURIComponent(encodedLabel) : '' };
  }
  if (raw.startsWith('occurrence/')) {
    const [, tableId, eventId, encodedLabel] = raw.split('/');
    return { page: 'occurrence', tableId, eventId: Number(eventId), label: encodedLabel ? decodeURIComponent(encodedLabel) : '' };
  }
  return { page: raw || 'dashboard' };
}

function goToHash() {
  const h = parseHash();
  if (h.page === 'detail' && h.tableId && h.label) {
    if (dataLoaded) openItemDetail(h.tableId, h.label);
    // else: load() will call this again once data arrives.
  } else if (h.page === 'occurrence' && h.tableId && h.eventId) {
    openOccurrence(h.tableId, h.eventId, h.label);
  } else {
    showPage(h.page);
  }
}
window.addEventListener('hashchange', goToHash);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Which line(s) a Duration chart plots — 'avgmax' (default) draws the usual
// two-line avg/max view, a percentile choice swaps to a single accent line
// for that one percentile instead. Per-page state (see durationMetric)
// since Requests/Queries/the generic detail page each have their own toggle.
function durationKeysAndColors(metric) {
  if (metric === 'p50' || metric === 'p95' || metric === 'p99') return { keys: [metric], colors: [cssVar('--accent')] };
  return { keys: ['avg', 'max'], colors: [cssVar('--text-muted'), cssVar('--warn')] };
}
let durationMetric = { requests: 'avgmax', queries: 'avgmax', detail: 'avgmax' };
document.querySelectorAll('.dm-toggle').forEach(group => {
  const key = group.dataset.dmKey;
  group.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      durationMetric[key] = btn.dataset.metric;
      group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      if (key === 'requests') renderRequestsPage();
      else if (key === 'queries') renderQueriesPage();
      else if (key === 'detail' && currentDetailContext.tableId) openItemDetail(currentDetailContext.tableId, currentDetailContext.label);
    });
  });
});

// One shared tooltip element for every chart's hit-targets (see data-tt on
// the hit-target rects/circles below), positioned per-hover via delegated
// listeners on document — delegation means this is wired exactly once and
// keeps working after render* replaces a chart's innerHTML, no re-wiring
// needed the way the drag-to-zoom listeners (attached per-<svg>) require.
const chartTooltipEl = document.getElementById('chart-tooltip');
function positionChartTooltip(clientX, clientY) {
  const margin = 12;
  const rect = chartTooltipEl.getBoundingClientRect();
  let x = clientX + margin, y = clientY + margin;
  if (x + rect.width > window.innerWidth) x = clientX - rect.width - margin;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - margin;
  chartTooltipEl.style.left = x + 'px';
  chartTooltipEl.style.top = y + 'px';
}
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('.hit-target');
  if (!target) return;
  chartTooltipEl.textContent = target.dataset.tt;
  chartTooltipEl.classList.add('visible');
  positionChartTooltip(e.clientX, e.clientY);
});
document.addEventListener('mousemove', (e) => {
  if (!chartTooltipEl.classList.contains('visible')) return;
  if (!e.target.closest('.hit-target')) return;
  positionChartTooltip(e.clientX, e.clientY);
});
document.addEventListener('mouseout', (e) => {
  if (!e.target.closest('.hit-target')) return;
  // Moving from one hit-target straight into an adjacent one (common —
  // they tile the whole chart) shouldn't flicker the tooltip off and back
  // on; only hide it once the pointer has actually left every hit-target.
  if (e.relatedTarget && e.relatedTarget.closest('.hit-target')) return;
  chartTooltipEl.classList.remove('visible');
});

// Recessive hairline gridlines + a slightly-more-visible baseline, drawn
// beneath the data — without these, a chart with sparse/quiet data reads as
// a blank void instead of "an empty period on an actual chart" (dataviz spec:
// gridlines one-step-off-surface, hairline, solid, recessive).
function gridlinesSvg(w, h, padTop, padBottom) {
  const gridline = cssVar('--gridline');
  const baseline = cssVar('--baseline');
  const rows = 3;
  let html = '';
  for (let i = 1; i < rows; i++) {
    const y = padTop + ((h - padTop - padBottom) / rows) * i;
    html += '<line x1="0" y1="' + y.toFixed(1) + '" x2="' + w + '" y2="' + y.toFixed(1) + '" stroke="' + gridline + '" stroke-width="1"></line>';
  }
  html += '<line x1="0" y1="' + (h - padBottom) + '" x2="' + w + '" y2="' + (h - padBottom) + '" stroke="' + baseline + '" stroke-width="1"></line>';
  return html;
}

// Start/end timestamps printed under a chart's own baseline — without these
// the exact window is only ever visible by hovering a bucket, so a reader
// skimming several charts at once has no time anchor at all.
function axisLabelsSvg(w, h, series) {
  if (!series.length) return '';
  const fmt = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const muted = cssVar('--text-muted');
  return '<text x="2" y="' + (h - 5) + '" font-size="10" fill="' + muted + '">' + escapeHtml(fmt(series[0].window)) + '</text>' +
    '<text x="' + (w - 2) + '" y="' + (h - 5) + '" font-size="10" fill="' + muted + '" text-anchor="end">' + escapeHtml(fmt(series[series.length - 1].window)) + '</text>';
}

// Fades a chart's new content in after a redraw instead of the instant
// innerHTML-replace snap — .chart-svg's own CSS transition does the actual
// animating, this just re-triggers it (0 -> 1) on the next frame.
function fadeInChart(svgEl) {
  svgEl.style.opacity = '0';
  requestAnimationFrame(() => { svgEl.style.opacity = '1'; });
}

// Click-drag across any bar/line chart zooms the whole dashboard into
// exactly that window — same 'custom:<since>:<until>' range the Custom-pill
// popover produces (applyCustomRange, defined further down), just driven by
// a drag instead of typed dates. Wired once per <svg> element and kept alive
// across re-renders via a flag on the node itself, since render* replaces
// the element's innerHTML on every load()/range change but never the
// element — svgEl._series is refreshed on every render so the handler
// always maps against the currently-displayed data, not stale data from
// whenever the listener was first attached.
function wireChartRangeSelect(svgEl, series, layout) {
  if (!svgEl) return;
  svgEl._series = series;
  if (svgEl._rangeSelectWired) return;
  svgEl._rangeSelectWired = true;
  const ns = 'http://www.w3.org/2000/svg';
  let startPx = null;
  let box = null;

  function pxToVb(clientX) {
    const rect = svgEl.getBoundingClientRect();
    const vb = svgEl.viewBox.baseVal;
    if (!rect.width) return 0;
    return ((clientX - rect.left) / rect.width) * vb.width;
  }
  // Bars sit at i * (w/n); lines sit at i * (w/(n-1)) — the exact inverse of
  // each render function's own x-placement formula above.
  function pxToWindow(x, curSeries) {
    const vb = svgEl.viewBox.baseVal;
    const n = curSeries.length;
    if (n < 2) return curSeries[0] ? curSeries[0].window : null;
    const slot = layout === 'bars' ? vb.width / n : vb.width / (n - 1);
    const idx = Math.max(0, Math.min(n - 1, Math.round(x / slot)));
    return curSeries[idx].window;
  }

  svgEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !svgEl._series || svgEl._series.length < 2) return;
    startPx = pxToVb(e.clientX);
    box = document.createElementNS(ns, 'rect');
    box.setAttribute('class', 'chart-select-box');
    box.setAttribute('y', '0');
    box.setAttribute('height', String(svgEl.viewBox.baseVal.height));
    box.setAttribute('x', String(startPx));
    box.setAttribute('width', '0');
    svgEl.appendChild(box);
    e.preventDefault();
  });
  // Bound to window, not svgEl — a fast drag can outrun the pointer past the
  // chart's own edges, and mousemove/mouseup shouldn't stop firing there.
  window.addEventListener('mousemove', (e) => {
    if (startPx === null || !box) return;
    const cur = pxToVb(e.clientX);
    box.setAttribute('x', String(Math.min(startPx, cur)));
    box.setAttribute('width', String(Math.abs(cur - startPx)));
  });
  window.addEventListener('mouseup', (e) => {
    if (startPx === null) return;
    const cur = pxToVb(e.clientX);
    const x0 = Math.min(startPx, cur), x1 = Math.max(startPx, cur);
    startPx = null;
    if (box) { box.remove(); box = null; }
    const vb = svgEl.viewBox.baseVal;
    if (x1 - x0 < vb.width * 0.02) return; // too small — a click, not a drag
    const curSeries = svgEl._series;
    if (!curSeries || curSeries.length < 2) return;
    // A real drag that ends just past the chart's bottom edge can land its
    // mouseup on a clickable row/table right below it — the browser then
    // fires one more native 'click' at that point, which would otherwise
    // navigate into whatever happened to be under the cursor. Swallow
    // exactly that one trailing click, capturing so it never reaches its target.
    const suppressClick = (ce) => { ce.preventDefault(); ce.stopPropagation(); };
    document.addEventListener('click', suppressClick, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', suppressClick, { capture: true }), 400);
    const bucketMs = curSeries[1].window - curSeries[0].window;
    const fromMs = pxToWindow(x0, curSeries);
    const toMs = pxToWindow(x1, curSeries) + bucketMs;
    applyCustomRange(fromMs, toMs);
  });
}

function sparkline(svgEl, series) {
  if (!svgEl) return; // markup for this category wasn't provisioned — nothing to draw into
  if (!series.length) { svgEl.innerHTML = ''; return; }
  const accent = cssVar('--accent');
  const max = Math.max(...series.map(p => p.count), 1);
  const w = svgEl.clientWidth || 300, h = 42, padTop = 6, padBottom = 12;
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  const points = series.map((p, i) => ({
    x: series.length > 1 ? i * stepX : w / 2,
    y: padTop + (1 - p.count / max) * (h - padTop - padBottom),
    count: p.count, window: p.window,
  }));
  const hits = points.map(p => {
    const time = new Date(p.window).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return '<circle class="hit-target" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="7" data-tt="' + escapeHtml(p.count + ' at ' + time) + '"></circle>';
  }).join('');
  svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  const grid = gridlinesSvg(w, h, padTop, padBottom);
  if (points.length < 2) {
    svgEl.innerHTML = grid + '<circle cx="' + points[0].x.toFixed(1) + '" cy="' + points[0].y.toFixed(1) + '" r="4" fill="' + accent + '"></circle>' + hits;
  } else {
    const last = points[points.length - 1];
    const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
    const areaPath = linePath + ' L' + last.x.toFixed(1) + ' ' + (h - padBottom) + ' L' + points[0].x.toFixed(1) + ' ' + (h - padBottom) + ' Z';
    svgEl.innerHTML = grid +
      '<path d="' + areaPath + '" fill="' + accent + '" fill-opacity="0.12"></path>' +
      '<path d="' + linePath + '" fill="none" stroke="' + accent + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>' + hits;
  }
}

// Stacked bars: one bar per time bucket, non-zero segments only, with a 2px
// surface gap between touching segments (dataviz mark spec). A full-height,
// full-slot-width hit target sits on top of each column so hovering anywhere
// in a bucket — not just a thin visible segment — reveals its breakdown.
function renderStackedBars(svgEl, series, keys, colors) {
  if (!svgEl) return;
  if (!series.length) { svgEl.innerHTML = ''; return; }
  const totals = series.map(s => keys.reduce((sum, k) => sum + s[k], 0));
  const max = Math.max(...totals, 1);
  const w = svgEl.clientWidth || 500, h = 140, padBottom = 20, barGap = 2;
  const slot = w / series.length;
  const barW = Math.min(24, Math.max(1, slot - barGap)); // mark spec: bars never fill their slot, capped at 24px
  svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  let html = gridlinesSvg(w, h, 0, padBottom);
  let hits = '';
  series.forEach((s, i) => {
    const x = i * slot;
    const segs = keys.map((k, ki) => ({ val: s[k], color: colors[ki] })).filter(seg => seg.val > 0);
    let yCursor = h - padBottom;
    segs.forEach((seg, si) => {
      const segH = Math.max(1, (seg.val / max) * (h - padBottom));
      if (si > 0) yCursor -= 2;
      html += '<rect x="' + x.toFixed(1) + '" y="' + (yCursor - segH).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + segH.toFixed(1) + '" fill="' + seg.color + '" rx="1.5"></rect>';
      yCursor -= segH;
    });
    const title = bucketTooltip(s.window, keys, keys.map(k => s[k]));
    hits += '<rect class="hit-target" x="' + x.toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + (h - padBottom) + '" data-tt="' + escapeHtml(title) + '"></rect>';
  });
  svgEl.innerHTML = html + axisLabelsSvg(w, h, series) + hits;
  fadeInChart(svgEl);
  wireChartRangeSelect(svgEl, series, 'bars');
}

function renderMultiLine(svgEl, series, keys, colors) {
  if (!svgEl) return;
  if (!series.length) { svgEl.innerHTML = ''; return; }
  const allValues = series.flatMap(s => keys.map(k => s[k]));
  const max = Math.max(...allValues, 1);
  const w = svgEl.clientWidth || 500, h = 140, padTop = 8, padBottom = 20;
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  let html = gridlinesSvg(w, h, padTop, padBottom);
  keys.forEach((key, ki) => {
    const points = series.map((s, i) => ({
      x: series.length > 1 ? i * stepX : w / 2,
      y: padTop + (1 - (s[key] || 0) / max) * (h - padTop - padBottom),
    }));
    if (points.length > 1) {
      const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
      html += '<path d="' + path + '" fill="none" stroke="' + colors[ki] + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>';
    } else if (points.length === 1) {
      html += '<circle cx="' + points[0].x.toFixed(1) + '" cy="' + points[0].y.toFixed(1) + '" r="4" fill="' + colors[ki] + '"></circle>';
    }
  });
  // One full-height hit stripe per x-position (not per-line-per-point) so
  // hovering shows every line's value at that time in a single tooltip.
  const hitW = Math.max(4, stepX);
  let hits = '';
  series.forEach((s, i) => {
    const x = series.length > 1 ? i * stepX : w / 2;
    const title = bucketTooltip(s.window, keys, keys.map(k => s[k] || 0));
    hits += '<rect class="hit-target" x="' + (x - hitW / 2).toFixed(1) + '" y="0" width="' + hitW.toFixed(1) + '" height="' + h + '" data-tt="' + escapeHtml(title) + '"></rect>';
  });
  svgEl.innerHTML = html + axisLabelsSvg(w, h, series) + hits;
  fadeInChart(svgEl);
  wireChartRangeSelect(svgEl, series, 'lines');
}

function debounce(fn, waitMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

// Values here are the storage layer's own category names (singular —
// 'query'/'exception', not the page-level 'queries'/'exceptions' keys used
// everywhere else in this file), since they go straight into
// /api/metrics?category=.
const TABLE_CATEGORY = { requests: 'http', queries: 'query', exceptions: 'exception', jobs: 'job', cache: 'cache' };
const TABLE_RENDER = {}; // filled in below, once the render*Page functions exist

async function searchTable(key, term) {
  pageState[key] = 0;
  if (!term) {
    tableRows[key] = null;
    TABLE_RENDER[key]();
    return;
  }
  try {
    tableRows[key] = await fetch(API + '/api/metrics?category=' + TABLE_CATEGORY[key] + '&range=' + range + '&search=' + encodeURIComponent(term)).then(r => r.json());
  } catch (e) {
    tableRows[key] = [];
  }
  TABLE_RENDER[key]();
}

function renderPagination(containerId, key, totalPages) {
  pageState[key] = Math.min(pageState[key], totalPages - 1);
  const p = pageState[key];
  const el = document.getElementById(containerId);
  el.innerHTML =
    '<span>Page ' + (p + 1) + ' of ' + totalPages + '</span>' +
    '<button data-dir="-1"' + (p <= 0 ? ' disabled' : '') + '>Prev</button>' +
    '<button data-dir="1"' + (p >= totalPages - 1 ? ' disabled' : '') + '>Next</button>';
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      pageState[key] += Number(btn.dataset.dir);
      TABLE_RENDER[key]();
    });
  });
}

// Click a sortable <th> (see table()'s data-col-index) to sort by it;
// click again to flip direction. Re-wired on every render since the table's
// innerHTML — headers included — is fully replaced each time.
function wireSort(containerId, key) {
  document.querySelectorAll('#' + containerId + ' th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const index = Number(th.dataset.colIndex);
      const current = sortState[key];
      sortState[key] = current && current.index === index ? { index, dir: -current.dir } : { index, dir: 1 };
      pageState[key] = 0;
      TABLE_RENDER[key]();
    });
  });
}

// tableRows[key] is non-null exactly when a search term is active (see
// searchTable) — picks between "nothing captured yet" and "nothing matches
// your search", since those call for different next actions from the user.
function emptyTableMessage(key, emptyText, noMatchText) {
  return tableRows[key] !== null ? noMatchText : emptyText;
}

function renderDashboardPage() {
  const { http, queries, exceptions, jobs, cache, runtime } = data;
  const httpTotal = http.reduce((n, r) => n + r.count, 0);
  const httpErrors = http.reduce((n, r) => n + r.errorCount, 0);
  const queryTotal = queries.reduce((n, r) => n + r.count, 0);
  const exceptionTotal = exceptions.reduce((n, r) => n + r.count, 0);
  const errorRate = httpTotal ? ((httpErrors / httpTotal) * 100).toFixed(1) : '0';
  const jobsTotal = jobs.reduce((n, r) => n + r.count, 0);
  const jobsFailed = jobs.reduce((n, r) => n + r.errorCount, 0);

  document.getElementById('stats').innerHTML =
    statCard(httpTotal, 'requests') +
    statCard(errorRate + '%', 'error rate', httpErrors > 0 ? 'critical' : '') +
    statCard(exceptionTotal, 'exceptions', exceptionTotal > 0 ? 'critical' : '') +
    (document.getElementById('page-jobs') ? statCard(jobsTotal, 'jobs', jobsFailed > 0 ? 'critical' : '') : '');

  const periodLabel = RANGE_LABEL[range] || 'selected period';
  const plural = (n, word) => n === 1 ? word : word + 's';
  const wasWere = (n) => n === 1 ? 'was' : 'were';

  const ovHttpNarrative = document.getElementById('ov-http-narrative');
  if (ovHttpNarrative) {
    ovHttpNarrative.innerHTML = httpTotal + ' ' + plural(httpTotal, 'request') + ' ' + wasWere(httpTotal) + ' made in the ' + periodLabel + '.' +
      (httpErrors ? ' <span class="bad">' + httpErrors + ' resulted in an error.</span>' : '');
    const bySlowest = summarize(http);
    document.getElementById('ov-http-preview').innerHTML = previewRows(bySlowest, r => r.path || r.label, r => ms(r.p95), 'No requests captured yet.');
  }

  const ovQueriesNarrative = document.getElementById('ov-queries-narrative');
  if (ovQueriesNarrative) {
    ovQueriesNarrative.innerHTML = queryTotal + ' ' + (queryTotal === 1 ? 'query was' : 'queries were') + ' executed in the ' + periodLabel + '.';
    document.getElementById('ov-queries-preview').innerHTML = previewRows(summarize(queries), r => r.label, r => ms(r.p95), 'No queries captured yet.');
  }

  const ovCpu = document.getElementById('ov-cpu');
  if (ovCpu) {
    // sparkline() expects {window, count} — metricSeries gives {window, avg},
    // same shape otherwise, so just rename the field rather than a second chart fn.
    const asCountSeries = (label) => metricSeries(runtime, label, range, undefined, bucketMsForRange(range)).map(p => ({ window: p.window, count: p.avg }));
    ovCpu.textContent = latestMetric(runtime, 'cpu').toFixed(1) + '%';
    document.getElementById('ov-heap').textContent = latestMetric(runtime, 'heap').toFixed(0) + 'MB';
    document.getElementById('ov-lag').textContent = latestMetric(runtime, 'eventLoopLag').toFixed(1) + 'ms';
    sparkline(document.getElementById('ov-cpu-spark'), asCountSeries('cpu'));
    sparkline(document.getElementById('ov-heap-spark'), asCountSeries('heap'));
    sparkline(document.getElementById('ov-lag-spark'), asCountSeries('eventLoopLag'));
  }
}

function renderRequestsPage() {
  const rows = data.http;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const normal = rows.reduce((n, r) => n + r.normalCount, 0);
  const c4xx = rows.reduce((n, r) => n + r.clientErrorCount, 0);
  const c5xx = rows.reduce((n, r) => n + r.serverErrorCount, 0);
  document.getElementById('req-total').textContent = total;
  document.getElementById('req-normal').textContent = normal;
  document.getElementById('req-4xx').textContent = c4xx;
  document.getElementById('req-5xx').textContent = c5xx;
  renderStackedBars(document.getElementById('req-status-chart'), statusSeries(rows, range, undefined, bucketMsForRange(range)), ['normal', 'clientError', 'serverError'], [cssVar('--text-muted'), cssVar('--warn'), cssVar('--critical')]);

  const durSeries = durationSeries(rows, range, undefined, bucketMsForRange(range));
  const totalDuration = rows.reduce((n, r) => n + r.totalDuration, 0);
  const avg = total ? totalDuration / total : 0;
  const max = rows.reduce((n, r) => Math.max(n, r.max), 0);
  document.getElementById('req-avg').textContent = ms(avg);
  document.getElementById('req-max').textContent = ms(max);
  const reqDm = durationKeysAndColors(durationMetric.requests);
  document.getElementById('req-duration-legend').innerHTML = legendHtml(reqDm.keys, reqDm.colors);
  renderMultiLine(document.getElementById('req-duration-chart'), durSeries, reqDm.keys, reqDm.colors);

  const summary = summarize(tableRows.requests !== null ? tableRows.requests : rows);
  document.getElementById('req-count').textContent = summary.length + ' routes';
  document.getElementById('requests-table').innerHTML = table(summary, [
    { label: 'Method', fmt: r => r.method || splitLabel(r.label).method },
    { label: 'Path', flex: true, fmt: r => r.path || splitLabel(r.label).path, sort: r => r.path || splitLabel(r.label).path },
    { label: 'Count', num: true, fmt: r => r.count, sort: r => r.count },
    { label: 'Avg', num: true, fmt: r => ms(r.totalDuration / r.count), sort: r => r.totalDuration / r.count, cellCls: r => durationCellClass(r.totalDuration / r.count) },
    { label: 'p95', num: true, fmt: r => ms(r.p95), sort: r => r.p95, cellCls: r => durationCellClass(r.p95) },
    { label: '1-3xx', num: true, fmt: r => r.normalCount, sort: r => r.normalCount },
    { label: '4xx', num: true, fmt: r => r.clientErrorCount, sort: r => r.clientErrorCount, cellCls: r => nonZeroClass(r.clientErrorCount, 'warn') },
    { label: '5xx', num: true, fmt: r => r.serverErrorCount, sort: r => r.serverErrorCount, cellCls: r => nonZeroClass(r.serverErrorCount, 'critical') },
  ], pageState.requests, sortState.requests, emptyTableMessage('requests', 'No requests captured yet — make one to see it here.', 'No routes match your search.'));
  wireSort('requests-table', 'requests');
  renderPagination('req-pagination', 'requests', pageCount(summary));
}

function renderQueriesPage() {
  if (!document.getElementById('page-queries')) return; // query plugin not provisioned
  const rows = data.queries;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const slow = rows.reduce((n, r) => n + r.slowCount, 0);
  const error = rows.reduce((n, r) => n + r.errorCount, 0);
  const ok = total - slow - error;
  document.getElementById('q-total').textContent = total;
  document.getElementById('q-ok').textContent = ok;
  document.getElementById('q-slow').textContent = slow;
  document.getElementById('q-error').textContent = error;
  renderStackedBars(document.getElementById('q-status-chart'), queryStatusSeries(rows, range, undefined, bucketMsForRange(range)), ['ok', 'slow', 'error'], [cssVar('--text-muted'), cssVar('--warn'), cssVar('--critical')]);

  const durSeries = durationSeries(rows, range, undefined, bucketMsForRange(range));
  const totalDuration = rows.reduce((n, r) => n + r.totalDuration, 0);
  const avg = total ? totalDuration / total : 0;
  const max = rows.reduce((n, r) => Math.max(n, r.max), 0);
  document.getElementById('q-avg').textContent = ms(avg);
  document.getElementById('q-max').textContent = ms(max);
  const qDm = durationKeysAndColors(durationMetric.queries);
  document.getElementById('q-duration-legend').innerHTML = legendHtml(qDm.keys, qDm.colors);
  renderMultiLine(document.getElementById('q-duration-chart'), durSeries, qDm.keys, qDm.colors);

  const summary = summarize(tableRows.queries !== null ? tableRows.queries : rows);
  document.getElementById('q-count').textContent = summary.length + ' queries';
  document.getElementById('queries-table').innerHTML = table(summary, [
    { label: 'Query', mono: true, flex: true, fmt: r => r.label, sort: r => r.label },
    { label: 'Count', num: true, fmt: r => r.count, sort: r => r.count },
    { label: 'Avg', num: true, fmt: r => ms(r.totalDuration / r.count), sort: r => r.totalDuration / r.count, cellCls: r => durationCellClass(r.totalDuration / r.count) },
    { label: 'p95', num: true, fmt: r => ms(r.p95), sort: r => r.p95, cellCls: r => durationCellClass(r.p95) },
    { label: 'Max', num: true, fmt: r => ms(r.max), sort: r => r.max, cellCls: r => durationCellClass(r.max) },
    { label: 'Slow', num: true, fmt: r => r.slowCount, sort: r => r.slowCount, cellCls: r => nonZeroClass(r.slowCount, 'warn') },
    { label: 'Errors', num: true, fmt: r => r.errorCount, sort: r => r.errorCount, cellCls: r => nonZeroClass(r.errorCount, 'critical') },
  ], pageState.queries, sortState.queries, emptyTableMessage('queries', 'No queries captured yet.', 'No queries match your search.'));
  wireSort('queries-table', 'queries');
  renderPagination('q-pagination', 'queries', pageCount(summary));
}

function renderExceptionsPage() {
  const rows = data.exceptions;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const unhandled = rows.reduce((n, r) => n + r.errorCount, 0);
  document.getElementById('exc-total').textContent = total;
  document.getElementById('exc-handled').textContent = total - unhandled;
  document.getElementById('exc-unhandled').textContent = unhandled;
  const excPeriodLabel = RANGE_LABEL[range] || 'selected period';
  document.getElementById('exc-narrative').innerHTML = total + ' ' + (total === 1 ? 'exception was' : 'exceptions were') + ' reported in the ' + excPeriodLabel + '.' +
    (unhandled ? ' <span class="bad">' + unhandled + ' unhandled.</span>' : '');
  // HttpException (NotFoundException, a validation failure, ...) records status
  // 'ok' — the app deliberately threw a structured error. Anything else is
  // status 'error': an actual unexpected bug. queryStatusSeries already computes
  // an ok/slow/error split per window; exceptions just never populate 'slow'.
  renderStackedBars(document.getElementById('exc-chart'), queryStatusSeries(rows, range, undefined, bucketMsForRange(range)), ['ok', 'error'], [cssVar('--text-muted'), cssVar('--critical')]);

  const summary = summarize(tableRows.exceptions !== null ? tableRows.exceptions : rows);
  document.getElementById('exc-count').textContent = summary.length + ' exception types';
  document.getElementById('exceptions-table').innerHTML = table(summary, [
    { label: 'Type', flex: true, fmt: r => r.label, sort: r => r.label },
    { label: 'Count', num: true, fmt: r => r.count, sort: r => r.count },
    { label: 'First seen', num: true, fmt: r => relativeTime(r.firstSeen), sort: r => r.firstSeen },
    { label: 'Last seen', num: true, fmt: r => relativeTime(r.lastSeen), sort: r => r.lastSeen },
  ], pageState.exceptions, sortState.exceptions, emptyTableMessage('exceptions', 'No exceptions reported — nothing to show yet.', 'No exception types match your search.'));
  wireSort('exceptions-table', 'exceptions');
  renderPagination('exc-pagination', 'exceptions', pageCount(summary));
}

function renderJobsPage() {
  if (!document.getElementById('page-jobs')) return; // no job plugin (e.g. BullMQ) provisioned
  const rows = data.jobs;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const completed = total - rows.reduce((n, r) => n + r.slowCount, 0) - rows.reduce((n, r) => n + r.errorCount, 0);
  const stalled = rows.reduce((n, r) => n + r.slowCount, 0);
  const failed = rows.reduce((n, r) => n + r.errorCount, 0);
  document.getElementById('jobs-total').textContent = total;
  document.getElementById('jobs-ok').textContent = completed;
  document.getElementById('jobs-stalled').textContent = stalled;
  document.getElementById('jobs-failed').textContent = failed;
  renderStackedBars(document.getElementById('jobs-status-chart'), queryStatusSeries(rows, range, undefined, bucketMsForRange(range)), ['ok', 'slow', 'error'], [cssVar('--text-muted'), cssVar('--warn'), cssVar('--critical')]);

  const summary = summarize(tableRows.jobs !== null ? tableRows.jobs : rows);
  document.getElementById('jobs-count').textContent = summary.length + ' queues';
  document.getElementById('jobs-table').innerHTML = table(summary, [
    { label: 'Queue', flex: true, fmt: r => r.label, sort: r => r.label },
    { label: 'Count', num: true, fmt: r => r.count, sort: r => r.count },
    { label: 'Completed', num: true, fmt: r => r.count - r.slowCount - r.errorCount, sort: r => r.count - r.slowCount - r.errorCount },
    { label: 'Stalled', num: true, fmt: r => r.slowCount, sort: r => r.slowCount, cellCls: r => nonZeroClass(r.slowCount, 'warn') },
    { label: 'Failed', num: true, fmt: r => r.errorCount, sort: r => r.errorCount, cellCls: r => nonZeroClass(r.errorCount, 'critical') },
  ], pageState.jobs, sortState.jobs, emptyTableMessage('jobs', 'No jobs processed yet.', 'No queues match your search.'));
  wireSort('jobs-table', 'jobs');
  renderPagination('jobs-pagination', 'jobs', pageCount(summary));
}

function renderCachePage() {
  if (!document.getElementById('page-cache')) return; // no cache plugin provisioned
  const rows = data.cache;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const misses = rows.reduce((n, r) => n + r.errorCount, 0);
  const hits = total - misses;
  const hitRate = total ? ((hits / total) * 100).toFixed(1) : '0';
  document.getElementById('cache-total').textContent = total;
  document.getElementById('cache-hits').textContent = hits;
  document.getElementById('cache-misses').textContent = misses;
  document.getElementById('cache-hit-rate').textContent = hitRate + '%';
  renderStackedBars(document.getElementById('cache-chart'), queryStatusSeries(rows, range, undefined, bucketMsForRange(range)), ['ok', 'slow', 'error'], [cssVar('--text-muted'), cssVar('--warn'), cssVar('--critical')]);

  const summary = summarize(tableRows.cache !== null ? tableRows.cache : rows);
  document.getElementById('cache-count').textContent = summary.length + ' key patterns';
  document.getElementById('cache-table').innerHTML = table(summary, [
    { label: 'Key pattern', mono: true, flex: true, fmt: r => r.label, sort: r => r.label },
    { label: 'Hits', num: true, fmt: r => r.count - r.errorCount, sort: r => r.count - r.errorCount },
    { label: 'Misses', num: true, fmt: r => r.errorCount, sort: r => r.errorCount, cellCls: r => nonZeroClass(r.errorCount, 'warn') },
    {
      label: 'Hit rate', num: true,
      fmt: r => (r.count ? (((r.count - r.errorCount) / r.count) * 100).toFixed(1) : '0') + '%',
      sort: r => (r.count ? (r.count - r.errorCount) / r.count : 0),
    },
  ], pageState.cache, sortState.cache, emptyTableMessage('cache', 'No cache activity yet.', 'No key patterns match your search.'));
  wireSort('cache-table', 'cache');
  renderPagination('cache-pagination', 'cache', pageCount(summary));
}


TABLE_RENDER.requests = renderRequestsPage;
TABLE_RENDER.queries = renderQueriesPage;
TABLE_RENDER.exceptions = renderExceptionsPage;
TABLE_RENDER.jobs = renderJobsPage;
TABLE_RENDER.cache = renderCachePage;

// Tracks the live search term per page (not just its last result) so a
// range-pill change can re-run the same search against the new range.
let searchTerm = { requests: '', queries: '', exceptions: '', jobs: '', cache: '' };
const debouncedSearch = {
  requests: debounce((term) => searchTable('requests', term), 250),
  queries: debounce((term) => searchTable('queries', term), 250),
  exceptions: debounce((term) => searchTable('exceptions', term), 250),
  jobs: debounce((term) => searchTable('jobs', term), 250),
  cache: debounce((term) => searchTable('cache', term), 250),
};
// Optional chaining throughout: a category's search box only exists in the
// DOM if its plugin is provisioned (see activeCategories in wolter.module.ts).
const SEARCH_INPUT_ID = { requests: 'req-search', queries: 'q-search', exceptions: 'exc-search', jobs: 'jobs-search', cache: 'cache-search' };
document.querySelectorAll('.search-box[data-search-key]').forEach(box => {
  const key = box.dataset.searchKey;
  const input = document.getElementById(SEARCH_INPUT_ID[key]);
  const clearBtn = box.querySelector('.search-clear');
  if (!input) return;
  input.addEventListener('input', (e) => {
    searchTerm[key] = e.target.value;
    box.classList.toggle('has-value', !!e.target.value);
    debouncedSearch[key](e.target.value);
  });
  // Clears immediately rather than through the 250ms debounce — a click is
  // already a deliberate, discrete action, no need to wait it out.
  clearBtn.addEventListener('click', () => {
    input.value = '';
    input.focus();
    searchTerm[key] = '';
    box.classList.remove('has-value');
    searchTable(key, '');
  });
});

// Click-through detail view: one item's own aggregated trend (min/p50/p95/p99,
// not just avg/max) plus — for requests/exceptions/queries — a "Recent
// Occurrences" list of actual raw events (headers/body/stack/parameters),
// fetched separately since only those 3 categories store raw events at all.
function statCard(value, unit, variant) {
  return '<div class="stat-card"><span class="n' + (variant ? ' ' + variant : '') + '">' + escapeHtml(value) + '</span><span class="u">' + escapeHtml(unit) + '</span></div>';
}

const DETAIL_TABLE_DATA_KEY = {
  'requests-table': { data: 'http', page: 'requests' },
  'queries-table': { data: 'queries', page: 'queries' },
  'exceptions-table': { data: 'exceptions', page: 'exceptions' },
  'jobs-table': { data: 'jobs', page: 'jobs' },
  'cache-table': { data: 'cache', page: 'cache' },
};

// Only these 3 categories have a raw-event endpoint — jobs/cache stay
// aggregate-only (they're plugin categories, out of scope for raw capture).
// category here is /api/events's own query param value (the storage
// layer's singular category name), kind is this file's own display-logic
// discriminator (used by eventRow/occurrenceBody etc.) — they're the same
// string for exception/query but historically diverged for http, so kept
// as two separate fields rather than collapsed into one.
const EVENTS_ENDPOINT = {
  'requests-table': { category: 'http', kind: 'http' },
  'exceptions-table': { category: 'exception', kind: 'exception' },
  'queries-table': { category: 'query', kind: 'query' },
};

function openItemDetail(tableId, label) {
  const entry = DETAIL_TABLE_DATA_KEY[tableId];
  if (!entry) return;
  const rows = data[entry.data] || [];
  const stats = summarize(rows).find(s => s.label === label);
  const series = labelSeries(rows, label, range, undefined, bucketMsForRange(range));
  const hasTiming = !!(stats && stats.max);

  currentDetailContext = { tableId, label };
  detailReturnPage = entry.page;
  document.getElementById('detail-back-label').textContent = PAGE_TITLES[entry.page];
  // Long, technical labels (raw SQL, mainly) get a smaller monospace
  // treatment instead of the default heading font — a giant serif-sized
  // multi-line SQL statement was dominating the whole page.
  const detailTitleEl = document.getElementById('detail-title');
  if (tableId === 'requests-table') {
    // Method as its own badge, path as the title — matches the table's own
    // Method/Path columns instead of dumping "GET /path" as one text blob.
    const { method, path } = stats && stats.method ? stats : splitLabel(label);
    detailTitleEl.innerHTML = (method ? '<span class="badge-method">' + escapeHtml(method) + '</span>' : '') + escapeHtml(path);
    detailTitleEl.classList.remove('mono-title');
  } else if (tableId === 'exceptions-table' && stats) {
    const unhandled = stats.errorCount > 0;
    const badge = '<span class="badge-status ' + (unhandled ? 'critical' : 'good') + '">' + (unhandled ? 'Unhandled' : 'Handled') + '</span>';
    detailTitleEl.innerHTML = badge + escapeHtml(label);
    detailTitleEl.classList.remove('mono-title');
  } else {
    detailTitleEl.textContent = tableId === 'queries-table' ? formatSql(label) : label;
    detailTitleEl.classList.toggle('mono-title', label.length > 60);
  }
  document.getElementById('detail-stats').innerHTML = stats ? (
    statCard(stats.count, 'count') +
    (hasTiming ? statCard(ms(stats.min), 'min') + statCard(ms(stats.p50), 'p50') + statCard(ms(stats.p95), 'p95') + statCard(ms(stats.p99), 'p99') + statCard(ms(stats.max), 'max') : '') +
    (stats.errorCount ? statCard(stats.errorCount, 'errors', 'critical') : '') +
    (stats.slowCount ? statCard(stats.slowCount, 'slow', 'warn') : '') +
    statCard(relativeTime(stats.firstSeen), 'first seen') +
    statCard(relativeTime(stats.lastSeen), 'last seen')
  ) : '';
  renderStackedBars(document.getElementById('detail-volume-chart'), series, ['count'], [cssVar('--accent')]);
  const durationChart = document.getElementById('detail-duration-chart');
  const durationLegend = document.getElementById('detail-duration-legend');
  if (hasTiming) {
    durationChart.closest('.detail-card').style.display = '';
    const detailDm = durationKeysAndColors(durationMetric.detail);
    durationLegend.innerHTML = legendHtml(detailDm.keys, detailDm.colors);
    renderMultiLine(durationChart, series, detailDm.keys, detailDm.colors);
  } else {
    durationChart.closest('.detail-card').style.display = 'none';
  }
  // showPage('detail') already blanks the masthead (PAGE_TITLES.detail === '')
  // — leave it blank rather than repeating the category name, since the
  // breadcrumb right below ("← Requests") already says exactly that, and the
  // eyebrow + h1 below it name the specific item. Setting it to PAGE_TITLES
  // here would put "Requests" in the masthead AND the breadcrumb, stacked.
  showPage('detail');
  history.replaceState(null, '', '#detail/' + tableId + '/' + encodeURIComponent(label));

  const occurrencesCard = document.getElementById('detail-occurrences');
  const eventsInfo = EVENTS_ENDPOINT[tableId];
  if (!eventsInfo) {
    occurrencesCard.style.display = 'none';
    return;
  }
  occurrencesCard.style.display = '';

  const filterEl = document.getElementById('detail-events-filter');
  currentDetailThresholds = hasTiming ? { avg: stats.totalDuration / stats.count, p50: stats.p50, p95: stats.p95, p99: stats.p99 } : null;
  currentDetailFilterMin = '0';
  filterEl.style.display = hasTiming ? '' : 'none';
  filterEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.min === '0'));

  document.getElementById('detail-events-list').innerHTML = '<div class="empty">Loading…</div>';
  fetch(API + '/api/events?category=' + eventsInfo.category + '&label=' + encodeURIComponent(label) + '&range=' + range)
    .then(r => r.json())
    .then(events => {
      currentDetailEvents = events;
      renderFilteredEvents(tableId, label, eventsInfo.kind);
    })
    .catch(() => { document.getElementById('detail-events-list').innerHTML = '<div class="empty">No recent occurrences</div>'; });
}

// Re-renders the "Recent Occurrences" list from currentDetailEvents against
// the currently active ≥Avg/P50/P95/P99 pill — pure filter over already-
// fetched data, no re-fetch on pill click.
function renderFilteredEvents(tableId, label, kind) {
  const threshold = currentDetailFilterMin === '0' ? 0 : (currentDetailThresholds || {})[currentDetailFilterMin] || 0;
  const filtered = threshold ? currentDetailEvents.filter(ev => (ev.duration || 0) >= threshold) : currentDetailEvents;
  document.getElementById('detail-events-list').innerHTML = eventsList(filtered, kind);
  wireOccurrenceRows(tableId, label);
}

document.querySelectorAll('#detail-events-filter button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentDetailFilterMin = btn.dataset.min;
    document.querySelectorAll('#detail-events-filter button').forEach(b => b.classList.toggle('active', b === btn));
    renderFilteredEvents(currentDetailContext.tableId, currentDetailContext.label, EVENTS_ENDPOINT[currentDetailContext.tableId].kind);
  });
});

// Each row rendered by eventRow() carries data-event-id — clicking it opens
// the full per-occurrence page rather than expanding inline (see
// openOccurrence). Re-wired on every render since the list's innerHTML is
// fully replaced each time.
function wireOccurrenceRows(tableId, label) {
  document.querySelectorAll('#detail-events-list .ev-row').forEach(el => {
    el.addEventListener('click', () => {
      location.hash = 'occurrence/' + tableId + '/' + el.dataset.eventId + '/' + encodeURIComponent(label);
    });
  });
}

// State for the occurrence page's breadcrumb clicks — set right before
// navigating there, same pattern as detailReturnPage above.
let currentOccurrence = { tableId: '', label: '', page: 'dashboard' };
// Read by the Copy as Markdown / Copy AI prompt buttons at click time —
// traceEvents starts empty and is filled in once the trace fetch resolves
// (see renderOccurrencePage), so a click before that lands just omits the
// correlated-trace section rather than waiting on it.
let currentOccurrenceCopyState = null;

async function copyOccurrenceText(build, btn) {
  if (!currentOccurrenceCopyState) return;
  const { ev, kind, traceEvents } = currentOccurrenceCopyState;
  try {
    await navigator.clipboard.writeText(build(ev, kind, traceEvents));
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    // Clipboard permission denied/unavailable — nothing to recover into,
    // the button just doesn't flash "Copied!".
  }
}
document.getElementById('occ-copy-md').addEventListener('click', (e) => copyOccurrenceText(occurrenceMarkdown, e.currentTarget));
document.getElementById('occ-copy-ai').addEventListener('click', (e) => copyOccurrenceText(occurrenceAiPrompt, e.currentTarget));
document.getElementById('occurrence-crumb-page').addEventListener('click', (e) => {
  e.preventDefault();
  showPage(currentOccurrence.page);
});
document.getElementById('occurrence-crumb-label').addEventListener('click', (e) => {
  e.preventDefault();
  openItemDetail(currentOccurrence.tableId, currentOccurrence.label);
});

// The dedicated per-occurrence page: one specific request/exception/query
// instance, its captured payload, and (when it carries a traceId) the
// correlated-trace timeline across every category that happened within the
// same inbound request. Uses a wide fixed range rather than the dashboard's
// selected range — this is a lookup by event id, not a trend over a window,
// so a shared link keeps working regardless of which range pill is active.
async function openOccurrence(tableId, eventId, label) {
  const entry = DETAIL_TABLE_DATA_KEY[tableId];
  const eventsInfo = EVENTS_ENDPOINT[tableId];
  if (!entry || !eventsInfo) return;

  currentOccurrence = { tableId, label, page: entry.page };
  document.getElementById('occurrence-crumb-page').textContent = PAGE_TITLES[entry.page];
  document.getElementById('occurrence-crumb-label').textContent = label;
  showPage('occurrence');
  history.replaceState(null, '', '#occurrence/' + tableId + '/' + eventId + '/' + encodeURIComponent(label));

  let events;
  try {
    events = await fetch(API + '/api/events?category=' + eventsInfo.category + '&label=' + encodeURIComponent(label) + '&range=30d').then(r => r.json());
  } catch (e) {
    events = [];
  }
  const ev = events.find(e => e.id === eventId);
  if (!ev) {
    document.getElementById('occurrence-path').textContent = 'Occurrence not found';
    document.getElementById('occurrence-method').style.display = 'none';
    document.getElementById('occurrence-info').innerHTML = '';
    document.getElementById('occurrence-events-summary').innerHTML = '';
    document.getElementById('occurrence-payload-card').style.display = 'none';
    document.getElementById('occurrence-timeline-card').style.display = 'none';
    document.getElementById('occ-actions').style.display = 'none';
    currentOccurrenceCopyState = null;
    return;
  }
  document.getElementById('occurrence-payload-card').style.display = '';
  document.getElementById('occurrence-timeline-card').style.display = '';
  renderOccurrencePage(ev, eventsInfo.kind);
  // Leave the masthead blank (showPage('occurrence') already did) — the
  // breadcrumb above already names the category, and .occurrence-header
  // below carries the specific path/label. Same reasoning as openItemDetail.
}

function renderOccurrencePage(ev, kind) {
  const meta = ev.meta || {};
  document.getElementById('occurrence-path').textContent = kind === 'http' ? (meta.path || ev.label) : kind === 'query' ? formatSql(ev.label) : ev.label;

  currentOccurrenceCopyState = { ev, kind, traceEvents: [] };
  document.getElementById('occ-actions').style.display = '';

  const methodEl = document.getElementById('occurrence-method');
  if (kind === 'http' && meta.method) {
    methodEl.textContent = meta.method;
    methodEl.style.display = '';
  } else if (kind === 'exception') {
    methodEl.textContent = ev.status === 'error' ? 'Unhandled' : 'Handled';
    methodEl.style.display = '';
  } else {
    methodEl.style.display = 'none';
  }

  const infoRows = [kvRow('Date', escapeHtml(new Date(ev.timestamp).toLocaleString()))];
  if (ev.statusCode !== undefined && ev.statusCode !== null) {
    infoRows.push(kvRow('Status code', '<span class="' + (ev.statusCode >= 500 ? 'kv-bad' : '') + '">' + ev.statusCode + '</span>'));
  }
  if (meta.method) infoRows.push(kvRow('Method', escapeHtml(meta.method)));
  if (ev.duration) infoRows.push(kvRow('Duration', ms(ev.duration)));
  document.getElementById('occurrence-info').innerHTML = infoRows.join('');

  document.getElementById('occurrence-payload').innerHTML = occurrenceBody(ev, kind);

  const timelineEl = document.getElementById('occurrence-timeline');
  const summaryEl = document.getElementById('occurrence-events-summary');
  const dupesEl = document.getElementById('occ-timeline-dupes');
  if (!ev.traceId) {
    timelineEl.innerHTML = '<div class="ev-empty">No correlated events found.</div>';
    summaryEl.innerHTML = occurrenceEventsSummaryHtml([], ev.id);
    dupesEl.style.display = 'none';
    return;
  }
  timelineEl.innerHTML = '<div class="ev-empty">Loading…</div>';
  summaryEl.innerHTML = '<div class="ev-empty">Loading…</div>';
  fetch(API + '/api/trace/' + encodeURIComponent(ev.traceId))
    .then(r => r.json())
    .then(traceEvents => {
      currentOccurrenceCopyState = { ev, kind, traceEvents };
      timelineEl.innerHTML = traceWaterfallHtml(traceEvents);
      summaryEl.innerHTML = occurrenceEventsSummaryHtml(traceEvents, ev.id);
      const dupCount = traceDuplicateQueryCount(traceEvents);
      dupesEl.style.display = dupCount ? '' : 'none';
      if (dupCount) dupesEl.querySelector('.n').textContent = dupCount;
    })
    .catch(() => {
      timelineEl.innerHTML = '<div class="ev-empty">Failed to load trace.</div>';
      summaryEl.innerHTML = occurrenceEventsSummaryHtml([], ev.id);
      dupesEl.style.display = 'none';
    });
}

document.getElementById('detail-back')?.addEventListener('click', (e) => {
  e.preventDefault();
  showPage(detailReturnPage);
});

Object.keys(DETAIL_TABLE_DATA_KEY).forEach(id => {
  document.getElementById(id)?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row-detail');
    if (tr) openItemDetail(id, tr.dataset.label);
  });
});

// Ticks independently of load()'s own 30s poll — a text-only update, no
// network — so "Updated Xs ago" stays accurate between polls instead of
// jumping in 30s steps.
function updateFreshness() {
  const el = document.getElementById('last-updated');
  if (!lastLoadTs) { el.textContent = ''; return; }
  const secs = Math.round((Date.now() - lastLoadTs) / 1000);
  el.textContent = secs < 5 ? 'Updated just now' : secs < 60 ? 'Updated ' + secs + 's ago' : 'Updated ' + Math.round(secs / 60) + 'm ago';
}

// Tracks the in-flight load so an overlapping call (rapid range-pill clicks,
// or the 30s poll firing while a slow request is still pending) aborts the
// older one instead of letting both run — otherwise whichever happens to
// resolve last wins, which can silently paint stale data over fresh data.
let currentLoadController;
async function load() {
  currentLoadController?.abort();
  const controller = new AbortController();
  currentLoadController = controller;
  const opts = { signal: controller.signal };
  // Only dim for a refetch after something's already on screen — the initial
  // load has its own full-page #initial-loading overlay, doubling up here
  // would just flash the content dim right before it first appears.
  if (dataLoaded) document.querySelector('.content').classList.add('is-refreshing');
  try {
    const metricsUrl = (category) => API + '/api/metrics?category=' + category + '&range=' + range;
    const [http, queries, exceptions, jobs, cacheRows, runtime, health] = await Promise.all([
      fetch(metricsUrl('http'), opts).then(r => r.json()),
      fetch(metricsUrl('query'), opts).then(r => r.json()),
      fetch(metricsUrl('exception'), opts).then(r => r.json()),
      fetch(metricsUrl('job'), opts).then(r => r.json()),
      fetch(metricsUrl('cache'), opts).then(r => r.json()),
      fetch(metricsUrl('runtime'), opts).then(r => r.json()),
      fetch(API + '/api/health', opts).then(r => r.json()),
    ]);
    data = { http, queries, exceptions, jobs, cache: cacheRows, runtime, health };
    renderDashboardPage();
    renderRequestsPage();
    renderQueriesPage();
    renderExceptionsPage();
    renderJobsPage();
    renderCachePage();
    document.querySelector('#health .dot').className = 'dot ' + (health.ok ? 'ok' : 'bad');
    // Retention lines only show once there's actually data old enough to
    // report — a brand-new install has nothing to say here yet.
    const retentionLines = [
      health.oldestEventTs ? 'Oldest raw event: ' + relativeTime(health.oldestEventTs) : null,
      health.oldestMetricTs ? 'Oldest rollup: ' + relativeTime(health.oldestMetricTs) : null,
    ].filter(Boolean);
    // The newline separator below is written as two backslashes followed by
    // the letter n. This whole script block is itself the body of one giant
    // outer template literal (see dashboard.html.ts) — a template literal
    // recognizes a single backslash followed by that letter as its own
    // newline escape and converts it during that outer evaluation, before
    // this string literal is ever parsed as JS. One backslash here would
    // therefore ship as an actual embedded line break inside a single-quoted
    // string below, which is a syntax error. Two backslashes survive that
    // first pass as a literal two-character escape sequence, which is what
    // this inner string literal needs to see.
    document.getElementById('health').dataset.tooltip = ['Storage: ' + (health.ok ? 'ok' : 'down'), ...retentionLines].join('\\n');
    document.getElementById('prod-sqlite-warning').style.display = health.sqliteInProduction ? '' : 'none';
    // Hidden with no plugins configured (core watchers only) — a dot for
    // zero plugins would just be clutter, not a signal.
    const plugins = health.plugins || [];
    const pluginsEl = document.getElementById('plugins-health');
    pluginsEl.style.display = plugins.length ? '' : 'none';
    if (plugins.length) {
      const allActive = plugins.every(p => p.active);
      pluginsEl.querySelector('.dot').className = 'dot ' + (allActive ? 'ok' : 'bad');
      pluginsEl.dataset.tooltip = plugins.map(p => p.name + ': ' + (p.active ? 'active' : 'failed (' + p.error + ')')).join('\\n');
    }
    lastLoadTs = Date.now();
    updateFreshness();
    if (!dataLoaded) {
      dataLoaded = true;
      goToHash(); // first load: restore a #detail/... hash now that data exists
    }
    hideInitialLoading();
  } catch (e) {
    // Aborted because a newer load() superseded this one — that newer call
    // owns rendering/loading-overlay duties, this one has nothing to do.
    if (controller.signal.aborted) return;
    // Dashboard fetch failures should never throw uncaught — just skip this tick.
    // Still clear the loading overlay so a failed first load shows the
    // (empty) page instead of a permanent spinner — the 30s poll retries.
    hideInitialLoading();
  } finally {
    if (!controller.signal.aborted) document.querySelector('.content').classList.remove('is-refreshing');
  }
}

function hideInitialLoading() {
  document.getElementById('initial-loading')?.remove();
}

function rerunActiveSearches() {
  Object.keys(searchTerm).forEach(key => { if (searchTerm[key]) searchTable(key, searchTerm[key]); });
}

const customBtn = document.getElementById('range-custom-btn');
function setActiveRangeButton(activeBtn) {
  document.querySelectorAll('.range-pills button').forEach(b => b.classList.toggle('active', b === activeBtn));
  if (activeBtn !== customBtn) customBtn.textContent = 'Custom';
}

document.querySelectorAll('.range-pills button.range-pill-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    range = btn.dataset.range;
    setActiveRangeButton(btn);
    load();
    rerunActiveSearches();
  });
});

// Custom range: a calendar-grid popover (click a start day, click an end
// day) for the date part, plus native <input type="time"> for the
// time-of-day part — that one's a small inline spinner, not a disruptive
// full overlay, so its native picker UX is worth keeping (unlike
// type="date"/datetime-local, which pop the browser's own unstyleable
// native calendar — the whole reason the date part is a custom grid
// instead; see the .custom-range-popover CSS comment).
const customPopover = document.getElementById('custom-range-popover');
const calGrid = document.getElementById('cr-cal-grid');
const calMonthLabel = document.getElementById('cr-cal-month');
const customFromTimeInput = document.getElementById('custom-range-from-time');
const customToTimeInput = document.getElementById('custom-range-to-time');
const customErrorEl = document.getElementById('custom-range-error');

let calViewDate = new Date(); // which month the grid is currently showing
let calSelStart = null; // date-only Date (local midnight) or null
let calSelEnd = null;

function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDay(a, b) { return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

function renderCalendar() {
  const year = calViewDate.getFullYear(), month = calViewDate.getMonth();
  calMonthLabel.textContent = calViewDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const startOffset = new Date(year, month, 1).getDay(); // 0 = Sunday
  const gridStart = new Date(year, month, 1 - startOffset);
  const today = dateOnly(new Date());
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const cls = ['cr-day'];
    if (sameDay(d, calSelStart)) cls.push('range-start');
    if (sameDay(d, calSelEnd)) cls.push('range-end');
    if (calSelStart && calSelEnd && d > calSelStart && d < calSelEnd) cls.push('in-range');
    if (sameDay(d, today)) cls.push('today');
    html += '<button type="button" class="' + cls.join(' ') + '"' + (d.getMonth() !== month ? ' disabled' : '') +
      ' data-date="' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '">' + d.getDate() + '</button>';
  }
  calGrid.innerHTML = html;
  calGrid.querySelectorAll('.cr-day:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      const [y, m, dd] = btn.dataset.date.split('-').map(Number);
      const clicked = new Date(y, m - 1, dd);
      // First click of a fresh selection, or clicking again after a
      // complete range, starts over; a second click before/after the
      // existing start extends the range in whichever direction it falls.
      if (!calSelStart || (calSelStart && calSelEnd)) {
        calSelStart = clicked; calSelEnd = null;
      } else if (clicked < calSelStart) {
        calSelStart = clicked;
      } else {
        calSelEnd = clicked;
      }
      renderCalendar();
    });
  });
}

document.getElementById('cr-cal-prev').addEventListener('click', () => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
  renderCalendar();
});
document.getElementById('cr-cal-next').addEventListener('click', () => {
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
  renderCalendar();
});

function openCustomPopover() {
  customPopover.hidden = false;
  customBtn.setAttribute('aria-expanded', 'true');
  customErrorEl.textContent = '';
  if (!calSelStart) {
    // Default to the same "last 24h" window the pills' own 24H preset
    // covers, so the calendar doesn't open on an arbitrary empty state.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3_600_000);
    calSelStart = dateOnly(yesterday);
    calSelEnd = dateOnly(now);
    calViewDate = new Date(calSelEnd);
    const fmtTime = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    customFromTimeInput.value = fmtTime(yesterday);
    customToTimeInput.value = fmtTime(now);
  }
  renderCalendar();
  positionCustomPopover();
}
// position: fixed with left/top computed here, clamped against both
// viewport edges — anchored under the Custom button by default, nudged
// left or right only as far as needed to stay fully on-screen regardless
// of window width or where the button happens to sit in the header.
function positionCustomPopover() {
  const margin = 8;
  const btnRect = customBtn.getBoundingClientRect();
  const popRect = customPopover.getBoundingClientRect();
  let left = btnRect.right - popRect.width; // default: right-align under the button
  left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
  customPopover.style.left = left + 'px';
  customPopover.style.top = (btnRect.bottom + margin) + 'px';
}
function closeCustomPopover() {
  customPopover.hidden = true;
  customBtn.setAttribute('aria-expanded', 'false');
}
customBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (customPopover.hidden) openCustomPopover(); else closeCustomPopover();
});
customPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!customPopover.hidden) closeCustomPopover(); });
document.getElementById('custom-range-cancel').addEventListener('click', closeCustomPopover);

// Accepts 'HH:mm' local time-of-day for the two inputs beside the calendar.
// The digit-class escapes below are written as two backslashes followed by
// the letter d. This function's source text lives inside the outer TS
// template literal that builds the whole <script> block — a single
// backslash there followed by that particular letter isn't a template
// literal's own recognized escape, so the literal's own evaluation just
// drops the backslash silently (no error, just the wrong character reaching
// the browser) rather than converting it to anything, unlike the newline
// case elsewhere in this file, which errors loudly instead.
function parseTimeOnly(str) {
  const m = String(str).trim().match(/^(\\d{2}):(\\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}
function formatRangeShort(from, to) {
  const opts = { month: 'short', day: 'numeric' };
  return from.toLocaleDateString([], opts) + ' – ' + to.toLocaleDateString([], opts);
}

// Shared by the popover's Apply button and drag-to-zoom on any chart —
// both just need to land on this exact same range/pill/reload sequence.
function applyCustomRange(fromMs, toMs) {
  range = 'custom:' + fromMs + ':' + toMs;
  customBtn.textContent = formatRangeShort(new Date(fromMs), new Date(toMs));
  setActiveRangeButton(customBtn);
  closeCustomPopover();
  load();
  rerunActiveSearches();
}

document.getElementById('custom-range-apply').addEventListener('click', () => {
  if (!calSelStart || !calSelEnd) {
    customErrorEl.textContent = 'Pick a start and end day on the calendar.';
    return;
  }
  const fromTime = parseTimeOnly(customFromTimeInput.value);
  const toTime = parseTimeOnly(customToTimeInput.value);
  if (!fromTime || !toTime) {
    customErrorEl.textContent = 'Enter valid start/end times, e.g. 09:00.';
    return;
  }
  const from = new Date(calSelStart.getFullYear(), calSelStart.getMonth(), calSelStart.getDate(), fromTime.h, fromTime.mi);
  const to = new Date(calSelEnd.getFullYear(), calSelEnd.getMonth(), calSelEnd.getDate(), toTime.h, toTime.mi);
  if (from.getTime() >= to.getTime()) {
    customErrorEl.textContent = 'Start must be before end — check the days and times picked.';
    return;
  }
  applyCustomRange(from.getTime(), to.getTime());
});

// Live polling — pausable (button) and always overridable (manual refresh),
// so a user reading a specific row doesn't have it repainted out from under
// them every 30s unless they want it to.
let liveEnabled = localStorage.getItem('wolter-live') !== '0';
let pollTimer;
function applyLiveIcon() {
  const btn = document.getElementById('live-toggle');
  btn.classList.toggle('live-on', liveEnabled);
  btn.dataset.tooltip = liveEnabled ? 'Pause live refresh' : 'Resume live refresh';
}
function startPolling() { stopPolling(); pollTimer = setInterval(load, 30_000); }
function stopPolling() { clearInterval(pollTimer); }
applyLiveIcon();
if (liveEnabled) startPolling();
document.getElementById('live-toggle').addEventListener('click', () => {
  liveEnabled = !liveEnabled;
  localStorage.setItem('wolter-live', liveEnabled ? '1' : '0');
  applyLiveIcon();
  if (liveEnabled) { load(); startPolling(); } else { stopPolling(); }
});
document.getElementById('refresh-now').addEventListener('click', (e) => {
  const icon = e.currentTarget;
  icon.classList.add('spinning');
  load().finally(() => setTimeout(() => icon.classList.remove('spinning'), 300));
});

let dataLoaded = false;
{
  const initial = parseHash();
  if (initial.page === 'occurrence' && initial.tableId && initial.eventId) {
    // Doesn't depend on load()'s data (it does its own dedicated fetch), so
    // it can open immediately — and must, since showPage() below would
    // otherwise history.replaceState the hash down to a bare '#occurrence',
    // losing the tableId/eventId/label a direct/shared link needs.
    openOccurrence(initial.tableId, initial.eventId, initial.label);
  } else if (!(initial.page === 'detail' && initial.tableId && initial.label)) {
    // Don't show the bare (empty) detail shell for a direct/refreshed detail
    // link — wait for load() to fetch data, then goToHash() fills it in.
    showPage(initial.page);
  }
}
load();
setInterval(updateFreshness, 1_000);
</script>
</body>
</html>`;
}
