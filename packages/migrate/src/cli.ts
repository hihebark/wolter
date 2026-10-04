#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqlDialect, renderSchemaSql } from './sql';
import { renderTypeOrmMigration } from './typeorm-migration';
import { renderPrismaSchema } from './prisma-schema';

type Target = 'typeorm' | 'prisma' | 'sql';
const TARGETS: Target[] = ['typeorm', 'prisma', 'sql'];
const DIALECTS: SqlDialect[] = ['postgres', 'mysql', 'sqlite'];

const USAGE = `Usage: wolter-migrate generate --target <${TARGETS.join('|')}> [--dir <path>] [--prefix wolter_] [--dialect <${DIALECTS.join('|')}>]

Writes a migration for the tables a custom WolterStorageDriver reads/writes —
nothing runs automatically; you review and apply the generated file yourself
with your project's own tooling (TypeORM's migration runner, \`prisma migrate\`,
or psql/mysql for raw SQL).`;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

export function run(argv: string[], log: (msg: string) => void = console.log): number {
  const [command, ...rest] = argv;
  if (command !== 'generate') {
    log(USAGE);
    return command ? 1 : 0;
  }

  const args = parseArgs(rest);
  const target = (args.target ?? 'typeorm') as Target;
  const dialect = (args.dialect ?? 'postgres') as SqlDialect;
  const dir = args.dir ?? '.';
  const prefix = args.prefix ?? 'wolter_';

  if (!TARGETS.includes(target)) {
    log(`Unknown --target '${target}'. Expected one of: ${TARGETS.join(', ')}.`);
    return 1;
  }
  if (target !== 'prisma' && !DIALECTS.includes(dialect)) {
    log(`Unknown --dialect '${dialect}'. Expected one of: ${DIALECTS.join(', ')}.`);
    return 1;
  }

  fs.mkdirSync(dir, { recursive: true });

  if (target === 'typeorm') {
    const timestamp = Date.now();
    const className = `CreateWolterTables${timestamp}`;
    const file = path.join(dir, `${timestamp}-create-wolter-tables.ts`);
    fs.writeFileSync(file, renderTypeOrmMigration(className, prefix, dialect));
    log(`Wrote ${file}\nRun it with your project's TypeORM migration runner (e.g. \`npm run migration:run\`).`);
  } else if (target === 'prisma') {
    const file = path.join(dir, 'wolter.prisma');
    fs.writeFileSync(file, renderPrismaSchema(prefix));
    log(`Wrote ${file}\nAppend its contents to schema.prisma, then run \`npx prisma migrate dev --name add_wolter_tables\`.`);
  } else {
    const file = path.join(dir, `wolter-${dialect}.sql`);
    fs.writeFileSync(file, renderSchemaSql(prefix, dialect).join('\n') + '\n');
    log(`Wrote ${file}\nRun it against your database yourself, e.g. \`psql -f ${file}\`.`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
