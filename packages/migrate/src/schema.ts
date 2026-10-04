// Canonical definition of the tables a WolterStorageDriver reads/writes —
// mirrors SqliteStorage's own schema (see @wolter/core's sqlite.storage.ts)
// so every generated target (TypeORM/Prisma/raw SQL) stays in sync with it.
export type ColumnType = 'text' | 'int' | 'bigint' | 'real';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable?: boolean;
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
  indexes: IndexDef[];
}

export const METRICS_TABLE: TableDef = {
  name: 'metrics',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'label', type: 'text' },
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
  ],
  primaryKey: ['category', 'label', 'window'],
  indexes: [
    { name: 'category_ts', columns: ['category', 'timestamp'] },
    { name: 'ts', columns: ['timestamp'] },
  ],
};

export const EVENTS_TABLE: TableDef = {
  name: 'events',
  columns: [
    { name: 'category', type: 'text' },
    { name: 'label', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'status_code', type: 'int', nullable: true },
    { name: 'duration', type: 'real' },
    { name: 'trace_id', type: 'text', nullable: true },
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

export const WOLTER_TABLES: TableDef[] = [METRICS_TABLE, EVENTS_TABLE];

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

export function indexName(table: TableDef, prefix: string, index: IndexDef): string {
  return `idx_${tableName(table, prefix)}_${index.name}`;
}
