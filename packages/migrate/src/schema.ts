// Canonical definition of the tables a WolterStorageDriver reads/writes —
// mirrors SqliteStorage's own schema (see @wolter/core's sqlite.storage.ts)
// so every generated target (TypeORM/Prisma/raw SQL) stays in sync with it.
export type ColumnType = 'text' | 'int' | 'bigint' | 'real';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable?: boolean;
  /** Text columns only: upper bound on stored length. MySQL can't put an unbounded TEXT column in
   *  a primary key, unique constraint or index, so a column that's part of one renders as
   *  VARCHAR(n) there. Postgres/SQLite keep TEXT, which they index fine. */
  maxLength?: number;
}

export interface IndexDef {
  /** Suffix only — full name is `idx_<table>_<name>`. */
  name: string;
  columns: string[];
}

export interface TableDef {
  /** Unprefixed table name, e.g. 'metrics'. */
  name: string;
  columns: ColumnDef[];
  /** Composite primary key columns. Omit when autoIncrementId is set. */
  primaryKey?: string[];
  /** Adds a leading auto-incrementing `id` primary key column. */
  autoIncrementId?: boolean;
  /** Columns that must be unique together (the get-or-create key behind resolveRoute/resolveLabel). */
  unique?: string[];
  indexes: IndexDef[];
}

// Sized to fit what core actually stores: labels are capped at 500 chars plus a '…' marker
// (normalize-query.ts's MAX_LABEL_LENGTH), categories/methods are short fixed words, trace ids
// are UUIDs. Kept small enough that every composite key stays under InnoDB's 3072-byte limit
// in utf8mb4 (4 bytes/char).
const CATEGORY_LEN = 32;
const LABEL_LEN = 512;

export const ROUTES_TABLE: TableDef = {
  name: 'routes',
  columns: [
    { name: 'method', type: 'text', maxLength: 16 },
    { name: 'path', type: 'text', maxLength: LABEL_LEN },
  ],
  autoIncrementId: true,
  unique: ['method', 'path'],
  indexes: [],
};

export const LABELS_TABLE: TableDef = {
  name: 'labels',
  columns: [
    { name: 'category', type: 'text', maxLength: CATEGORY_LEN },
    { name: 'label', type: 'text', maxLength: LABEL_LEN },
  ],
  autoIncrementId: true,
  unique: ['category', 'label'],
  indexes: [],
};

export const METRICS_TABLE: TableDef = {
  name: 'metrics',
  columns: [
    { name: 'category', type: 'text', maxLength: CATEGORY_LEN },
    { name: 'label', type: 'text', maxLength: LABEL_LEN },
    { name: 'window', type: 'bigint' },
    { name: 'count', type: 'int' },
    { name: 'error_count', type: 'int' },
    { name: 'slow_count', type: 'int' },
    { name: 'normal_count', type: 'int' },
    { name: 'client_error_count', type: 'int' },
    { name: 'server_error_count', type: 'int' },
    { name: 'total_duration', type: 'real' },
    { name: 'min', type: 'real' },
    { name: 'max', type: 'real' },
    { name: 'p50', type: 'real' },
    { name: 'p95', type: 'real' },
    { name: 'p99', type: 'real' },
    { name: 'timestamp', type: 'bigint' },
    // Ids into the routes/labels tables above (see WolterStorageDriver.resolveRoute/resolveLabel).
    { name: 'route_id', type: 'bigint', nullable: true },
    { name: 'label_id', type: 'bigint', nullable: true },
  ],
  primaryKey: ['category', 'label', 'window'],
  indexes: [
    { name: 'category_ts', columns: ['category', 'timestamp'] },
    { name: 'ts', columns: ['timestamp'] },
    { name: 'route_id', columns: ['route_id'] },
    { name: 'label_id', columns: ['label_id'] },
  ],
};

export const EVENTS_TABLE: TableDef = {
  name: 'events',
  columns: [
    { name: 'category', type: 'text', maxLength: CATEGORY_LEN },
    { name: 'label', type: 'text', maxLength: LABEL_LEN },
    { name: 'status', type: 'text' },
    { name: 'status_code', type: 'int', nullable: true },
    { name: 'duration', type: 'real' },
    { name: 'trace_id', type: 'text', nullable: true, maxLength: 64 },
    // JSON-stringified — kept as plain text rather than a dialect-specific
    // JSON/JSONB type so the raw-SQL target stays portable.
    { name: 'meta', type: 'text' },
    { name: 'timestamp', type: 'bigint' },
  ],
  autoIncrementId: true,
  indexes: [
    { name: 'category_label_ts', columns: ['category', 'label', 'timestamp'] },
    { name: 'trace_id', columns: ['trace_id'] },
  ],
};

// Issue tracking (IssueStore): one row per exception group, keyed by its
// fingerprint (the exception label), plus its comments.
export const ISSUES_TABLE: TableDef = {
  name: 'issues',
  columns: [
    { name: 'fingerprint', type: 'text', maxLength: LABEL_LEN },
    { name: 'status', type: 'text', maxLength: 16 },
    { name: 'priority', type: 'text', nullable: true, maxLength: 16 },
    { name: 'assignee', type: 'text', nullable: true, maxLength: 100 },
    { name: 'first_seen', type: 'bigint' },
    { name: 'last_seen', type: 'bigint' },
    { name: 'resolved_at', type: 'bigint', nullable: true },
    { name: 'updated_at', type: 'bigint' },
  ],
  autoIncrementId: true,
  unique: ['fingerprint'],
  indexes: [{ name: 'status', columns: ['status'] }],
};

export const ISSUE_COMMENTS_TABLE: TableDef = {
  name: 'issue_comments',
  columns: [
    { name: 'issue_id', type: 'bigint' },
    { name: 'author', type: 'text' },
    { name: 'body', type: 'text' },
    { name: 'created_at', type: 'bigint' },
  ],
  autoIncrementId: true,
  indexes: [{ name: 'issue_id', columns: ['issue_id'] }],
};

// Lookup tables first so metrics' route_id/label_id point at tables that already exist,
// and issues before the comments that reference them.
export const WOLTER_TABLES: TableDef[] = [ROUTES_TABLE, LABELS_TABLE, METRICS_TABLE, EVENTS_TABLE, ISSUES_TABLE, ISSUE_COMMENTS_TABLE];

// Same rule SqliteStorage enforces on its own tablePrefix option — kept in
// sync deliberately since both ultimately name tables in a raw SQL string.
const SAFE_PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validatePrefix(prefix: string): void {
  if (!SAFE_PREFIX.test(prefix)) {
    throw new Error(`Table prefix '${prefix}' must match ${SAFE_PREFIX} (letters, digits, underscore; not starting with a digit).`);
  }
}

export function tableName(table: TableDef, prefix: string): string {
  return `${prefix}${table.name}`;
}

export function uniqueName(table: TableDef, prefix: string): string {
  return `uq_${tableName(table, prefix)}`;
}

export function indexName(table: TableDef, prefix: string, index: IndexDef): string {
  return `idx_${tableName(table, prefix)}_${index.name}`;
}
