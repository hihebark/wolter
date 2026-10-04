import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrismaSchema } from './prisma-schema';

test('renders both models, mapped to prefixed table names, with a composite id on the metrics model', () => {
  const schema = renderPrismaSchema('wolter_');
  assert.match(schema, /model WolterMetric \{/);
  assert.match(schema, /model WolterEvent \{/);
  assert.match(schema, /@@map\("wolter_metrics"\)/);
  assert.match(schema, /@@map\("wolter_events"\)/);
  assert.match(schema, /@@id\(\[category, label, window\]\)/);
  assert.match(schema, /id\s+BigInt\s+@id @default\(autoincrement\(\)\)/);
});

test('camelCases snake_case column names while keeping the @map to the real column', () => {
  const schema = renderPrismaSchema('wolter_');
  assert.match(schema, /errorCount\s+Int\s+@map\("error_count"\)/);
  assert.match(schema, /traceId\s+String\?\s+@map\("trace_id"\)/);
});

test('rejects an unsafe table prefix', () => {
  assert.throws(() => renderPrismaSchema('wolter;drop'), /must match/);
});
