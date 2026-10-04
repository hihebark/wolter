import { ColumnType, TableDef, WOLTER_TABLES, indexName, tableName, validatePrefix } from './schema';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

const TYPE_MAP: Record<SqlDialect, Record<ColumnType, string>> = {
  postgres: { text: 'TEXT', int: 'INTEGER', bigint: 'BIGINT', real: 'DOUBLE PRECISION' },
  mysql: { text: 'TEXT', int: 'INT', bigint: 'BIGINT', real: 'DOUBLE' },
  sqlite: { text: 'TEXT', int: 'INTEGER', bigint: 'INTEGER', real: 'REAL' },
};

function quote(dialect: SqlDialect, identifier: string): string {
  return dialect === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
}

function autoIncrementColumnSql(dialect: SqlDialect): string {
  if (dialect === 'postgres') return `${quote(dialect, 'id')} BIGSERIAL PRIMARY KEY`;
  if (dialect === 'mysql') return `${quote(dialect, 'id')} BIGINT AUTO_INCREMENT PRIMARY KEY`;
  return `${quote(dialect, 'id')} INTEGER PRIMARY KEY AUTOINCREMENT`;
}

export function createTableSql(table: TableDef, prefix: string, dialect: SqlDialect): string {
  const lines: string[] = [];
  if (table.autoIncrementId) lines.push(autoIncrementColumnSql(dialect));
  for (const col of table.columns) {
    lines.push(`${quote(dialect, col.name)} ${TYPE_MAP[dialect][col.type]}${col.nullable ? '' : ' NOT NULL'}`);
  }
  if (table.primaryKey) {
    lines.push(`PRIMARY KEY (${table.primaryKey.map((c) => quote(dialect, c)).join(', ')})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(dialect, tableName(table, prefix))} (\n  ${lines.join(',\n  ')}\n)`;
}

// MySQL has no CREATE INDEX ... IF NOT EXISTS — the generated migration only
// ever runs once (tracked by whichever migration runner executes it), so the
// guard is dropped there rather than working around it with a stored procedure.
export function createIndexSql(table: TableDef, prefix: string, dialect: SqlDialect): string[] {
  return table.indexes.map((idx) => {
    const guard = dialect === 'mysql' ? '' : 'IF NOT EXISTS ';
    return `CREATE INDEX ${guard}${quote(dialect, indexName(table, prefix, idx))} ON ${quote(dialect, tableName(table, prefix))}(${idx.columns
      .map((c) => quote(dialect, c))
      .join(', ')})`;
  });
}

// Returns one array element per complete SQL statement (a CREATE TABLE's
// internal newlines stay inside its own element) — callers that need line
// boundaries (a flat .sql file) can join with '\n'; callers that need one
// runnable unit per statement (a TypeORM migration's queryRunner.query()
// calls) must NOT re-split this by '\n', or a multi-line CREATE TABLE gets
// torn into invalid fragments.
export function renderSchemaSql(prefix: string, dialect: SqlDialect): string[] {
  validatePrefix(prefix);
  const statements: string[] = [];
  for (const table of WOLTER_TABLES) {
    statements.push(createTableSql(table, prefix, dialect) + ';');
    statements.push(...createIndexSql(table, prefix, dialect).map((s) => s + ';'));
  }
  return statements;
}

export function renderDropSchemaSql(prefix: string, dialect: SqlDialect): string[] {
  validatePrefix(prefix);
  return WOLTER_TABLES.map((t) => `DROP TABLE IF EXISTS ${quote(dialect, tableName(t, prefix))};`);
}
