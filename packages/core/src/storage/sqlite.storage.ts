import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AggregatedBucket, RawEvent, RetentionInfo, WolterStorageDriver } from '../interfaces/storage.interface';

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

// Presets stay "since X ago through now". A custom range picked in the
// dashboard's range-pills carries its own absolute bounds instead, encoded
// as 'custom:<sinceMs>:<untilMs>' (see dashboard-logic.js's parseRangeBounds,
// the frontend twin of this parser). Falls back to the 1h preset on anything
// malformed rather than letting NaN bounds reach the SQL layer.
function parseRange(range: string): { since: number; until: number } {
  const now = Date.now();
  if (range?.startsWith('custom:')) {
    const [, sinceStr, untilStr] = range.split(':');
    const since = Number(sinceStr);
    const until = Number(untilStr);
    if (Number.isFinite(since) && Number.isFinite(until) && until > since) {
      return { since, until };
    }
  }
  return { since: now - (RANGE_MS[range] ?? RANGE_MS['1h']), until: now };
}

// Only plain identifier characters — this is interpolated directly into raw
// SQL (table names can't be bound params), so a malformed prefix must fail
// fast in the constructor rather than produce a confusing syntax error later.
const SAFE_PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class SqliteStorage implements WolterStorageDriver {
  private db: Database.Database;
  private readonly metricsTable: string;
  private readonly eventsTable: string;
  private readonly routesTable: string;
  private readonly labelsTable: string;

  // tablePrefix lets Wolter's tables coexist in a database the host app
  // already owns (its own migrations, its own naming) without colliding —
  // defaults to 'wolter_' so a shared DB is safe out of the box.
  constructor(dbPath: string, tablePrefix = 'wolter_') {
    if (!SAFE_PREFIX.test(tablePrefix)) {
      throw new Error(`[Wolter] storage.tablePrefix '${tablePrefix}' must match ${SAFE_PREFIX} (letters, digits, underscore; not starting with a digit).`);
    }
    this.metricsTable = `${tablePrefix}metrics`;
    this.eventsTable = `${tablePrefix}events`;
    this.routesTable = `${tablePrefix}routes`;
    this.labelsTable = `${tablePrefix}labels`;

    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    // ponytail: no migration path for pre-existing DB files — v0.1 is unreleased,
    // so there's no real data to preserve. Delete wolter.db if upgrading a dev copy.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.routesTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        UNIQUE(method, path)
      );

      -- Generic backend-owned identity for every non-http category (query/exception/job/cache/
      -- runtime) — same idea as ${this.routesTable}, just without a method/path split since these
      -- labels are already a single flat grouping string (see resolveLabel). Both this table and
      -- ${this.routesTable} are swept in prune() once no metric bucket references them anymore.
      CREATE TABLE IF NOT EXISTS ${this.labelsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        UNIQUE(category, label)
      );

      CREATE TABLE IF NOT EXISTS ${this.metricsTable} (
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        window INTEGER NOT NULL,
        count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        slow_count INTEGER NOT NULL,
        normal_count INTEGER NOT NULL,
        client_error_count INTEGER NOT NULL,
        server_error_count INTEGER NOT NULL,
        total_duration REAL NOT NULL,
        min REAL NOT NULL,
        max REAL NOT NULL,
        p50 REAL NOT NULL,
        p95 REAL NOT NULL,
        p99 REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        route_id INTEGER REFERENCES ${this.routesTable}(id),
        label_id INTEGER REFERENCES ${this.labelsTable}(id),
        PRIMARY KEY (category, label, window)
      );
      CREATE INDEX IF NOT EXISTS idx_${this.metricsTable}_category_ts ON ${this.metricsTable}(category, timestamp);
      -- category is the leading column above, so it doesn't serve prune()'s
      -- DELETE FROM metrics WHERE timestamp < ? — that has no category
      -- filter at all, so a composite index whose first column it never
      -- constrains is no better than a full table scan. A dedicated
      -- timestamp-only index is what that query (run every 5 minutes,
      -- growing table) actually needs.
      CREATE INDEX IF NOT EXISTS idx_${this.metricsTable}_ts ON ${this.metricsTable}(timestamp);
      -- Same reasoning as idx_${this.metricsTable}_ts above, for prune()'s orphan sweep:
      -- 'NOT IN (SELECT route_id/label_id FROM metrics WHERE ... IS NOT NULL)' has nothing
      -- to do with (category, label, window), so without these it's a full table scan
      -- every 5 minutes. Partial (WHERE ... IS NOT NULL) since most non-http/unmatched-http
      -- rows never populate one or the other.
      CREATE INDEX IF NOT EXISTS idx_${this.metricsTable}_route_id ON ${this.metricsTable}(route_id) WHERE route_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_${this.metricsTable}_label_id ON ${this.metricsTable}(label_id) WHERE label_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        duration REAL NOT NULL,
        trace_id TEXT,
        meta TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_category_label_ts ON ${this.eventsTable}(category, label, timestamp);
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_trace_id ON ${this.eventsTable}(trace_id);
    `);
  }

  write(bucket: AggregatedBucket): void {
    this.db
      .prepare(
        `INSERT INTO ${this.metricsTable} (category, label, window, count, error_count, slow_count, normal_count, client_error_count, server_error_count, total_duration, min, max, p50, p95, p99, timestamp, route_id, label_id)
         VALUES (@category, @label, @window, @count, @errorCount, @slowCount, @normalCount, @clientErrorCount, @serverErrorCount, @totalDuration, @min, @max, @p50, @p95, @p99, @timestamp, @routeId, @labelId)
         ON CONFLICT(category, label, window) DO UPDATE SET
           count=excluded.count, error_count=excluded.error_count, slow_count=excluded.slow_count,
           normal_count=excluded.normal_count, client_error_count=excluded.client_error_count, server_error_count=excluded.server_error_count,
           total_duration=excluded.total_duration,
           min=excluded.min, max=excluded.max, p50=excluded.p50, p95=excluded.p95, p99=excluded.p99,
           route_id=excluded.route_id, label_id=excluded.label_id`,
      )
      .run({ ...bucket, routeId: bucket.routeId ?? null, labelId: bucket.labelId ?? null });
  }

  // Get-or-create by the (method, path) unique index — a route row is only ever
  // created the first time it's actually hit (see http.interceptor.ts), never
  // pre-registered from the app's router.
  resolveRoute(method: string, path: string): number {
    return this.getOrCreateId(this.routesTable, 'method', method, 'path', path);
  }

  // Same get-or-create shape as resolveRoute, generalized to every other category.
  resolveLabel(category: string, label: string): number {
    return this.getOrCreateId(this.labelsTable, 'category', category, 'label', label);
  }

  // Shared upsert-for-id behind resolveRoute/resolveLabel — both are a 2-column unique
  // lookup table with an autoincrement id. DO UPDATE (not DO NOTHING) is required to get
  // RETURNING id back on a conflict — SQLite's DO NOTHING skips RETURNING on the conflicting
  // row, so a plain get-or-create needs the no-op update to make RETURNING fire either way.
  // col1/col2 are always internal literal constants from the two call sites above, never
  // external input, so interpolating them into the SQL is safe.
  private getOrCreateId(table: string, col1: string, val1: string, col2: string, val2: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO ${table} (${col1}, ${col2}) VALUES (?, ?)
         ON CONFLICT(${col1}, ${col2}) DO UPDATE SET ${col1} = excluded.${col1}
         RETURNING id`,
      )
      .get(val1, val2) as { id: number };
    return row.id;
  }

  query(category: string, range: string, search?: string): AggregatedBucket[] {
    const { since, until } = parseRange(range);
    const params: unknown[] = [category, since, until];
    let sql = `SELECT m.category, m.label, m.window, m.count, m.error_count as errorCount, m.slow_count as slowCount,
                m.normal_count as normalCount, m.client_error_count as clientErrorCount, m.server_error_count as serverErrorCount,
                m.total_duration as totalDuration, m.min, m.max, m.p50, m.p95, m.p99, m.timestamp,
                m.route_id as routeId, r.method as method, r.path as path, m.label_id as labelId
         FROM ${this.metricsTable} m LEFT JOIN ${this.routesTable} r ON r.id = m.route_id
         WHERE m.category = ? AND m.timestamp >= ? AND m.timestamp <= ?`;
    if (search) {
      sql += ` AND m.label LIKE ? ESCAPE '\\'`;
      params.push(`%${search.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    }
    sql += ` ORDER BY m.window ASC`;
    // better-sqlite3 returns SQL NULL as JS null (unmatched LEFT JOIN, unset route_id/label_id) —
    // normalized to undefined here so the row actually matches AggregatedBucket's declared type
    // instead of quietly returning `T | null` for fields the interface promises are `T | undefined`.
    const rows = this.db.prepare(sql).all(...params) as Array<
      Omit<AggregatedBucket, 'routeId' | 'method' | 'path' | 'labelId'> & {
        routeId: number | null;
        method: string | null;
        path: string | null;
        labelId: number | null;
      }
    >;
    return rows.map((r) => ({
      ...r,
      routeId: r.routeId ?? undefined,
      method: r.method ?? undefined,
      path: r.path ?? undefined,
      labelId: r.labelId ?? undefined,
    }));
  }

  prune(olderThan: number): void {
    this.db.prepare(`DELETE FROM ${this.metricsTable} WHERE timestamp < ?`).run(olderThan);
    // Sweep routes/labels that no metric bucket references anymore — run after the
    // metrics delete above so a route/label whose last bucket just aged out is
    // caught in the same pass, not one prune cycle later.
    this.db.prepare(`DELETE FROM ${this.routesTable} WHERE id NOT IN (SELECT route_id FROM ${this.metricsTable} WHERE route_id IS NOT NULL)`).run();
    this.db.prepare(`DELETE FROM ${this.labelsTable} WHERE id NOT IN (SELECT label_id FROM ${this.metricsTable} WHERE label_id IS NOT NULL)`).run();
  }

  health(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  retentionInfo(): RetentionInfo {
    const event = this.db.prepare(`SELECT MIN(timestamp) as ts FROM ${this.eventsTable}`).get() as { ts: number | null };
    const metric = this.db.prepare(`SELECT MIN(timestamp) as ts FROM ${this.metricsTable}`).get() as { ts: number | null };
    return { oldestEventTs: event.ts ?? null, oldestMetricTs: metric.ts ?? null };
  }

  close(): void {
    this.db.close();
  }

  writeEvent(event: RawEvent): void {
    this.db
      .prepare(
        `INSERT INTO ${this.eventsTable} (category, label, status, status_code, duration, trace_id, meta, timestamp)
         VALUES (@category, @label, @status, @statusCode, @duration, @traceId, @meta, @timestamp)`,
      )
      .run({
        category: event.category,
        label: event.label,
        status: event.status,
        statusCode: event.statusCode ?? null,
        duration: event.duration,
        traceId: event.traceId ?? null,
        meta: JSON.stringify(event.meta ?? {}),
        timestamp: event.timestamp,
      });
  }

  queryEvents(category: string, label: string, range: string, limit: number): RawEvent[] {
    const { since, until } = parseRange(range);
    const rows = this.db
      .prepare(
        `SELECT id, category, label, status, status_code as statusCode, duration, trace_id as traceId, meta, timestamp
         FROM ${this.eventsTable} WHERE category = ? AND label = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(category, label, since, until, limit) as Array<Omit<RawEvent, 'meta'> & { meta: string }>;
    return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) }));
  }

  queryEventsByTrace(traceId: string, limit: number): RawEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, category, label, status, status_code as statusCode, duration, trace_id as traceId, meta, timestamp
         FROM ${this.eventsTable} WHERE trace_id = ?
         ORDER BY timestamp ASC, id ASC LIMIT ?`,
      )
      .all(traceId, limit) as Array<Omit<RawEvent, 'meta'> & { meta: string }>;
    return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) }));
  }

  pruneEvents(category: string, olderThan: number, keepCount: number): void {
    this.db.prepare(`DELETE FROM ${this.eventsTable} WHERE category = ? AND timestamp < ?`).run(category, olderThan);
    this.db
      .prepare(
        `DELETE FROM ${this.eventsTable} WHERE category = ? AND id NOT IN (
           SELECT id FROM ${this.eventsTable} WHERE category = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(category, category, keepCount);
  }
}
