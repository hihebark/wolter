import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WolterLoggerPlugin } from './logger.plugin';
import { TraceContext } from '../trace-context';
import { Recorder } from '../recorder';

function silence(logger: WolterLoggerPlugin): void {
  // ConsoleLogger's own output isn't under test here — mute it so the suite
  // doesn't spam stdout/stderr on every run.
  for (const m of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
    Object.getPrototypeOf(Object.getPrototypeOf(logger))[m] = () => {};
  }
}

test('records a log line to the recorder when inside a trace context', () => {
  const recorded: unknown[] = [];
  const recorder = { record: (e: unknown) => recorded.push(e) } as unknown as Recorder;
  const logger = new WolterLoggerPlugin();
  silence(logger);
  logger.register(recorder);

  TraceContext.run('trace-1', () => logger.log('checkout started', 'CheckoutService'));

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    plugin: 'logger',
    category: 'log',
    label: 'checkout started',
    status: 'ok',
    traceId: 'trace-1',
    meta: { level: 'log', context: 'CheckoutService' },
    timestamp: (recorded[0] as { timestamp: number }).timestamp,
  });
});

test('does not record outside a trace context — untraceable noise, not a correlated event', () => {
  const recorded: unknown[] = [];
  const recorder = { record: (e: unknown) => recorded.push(e) } as unknown as Recorder;
  const logger = new WolterLoggerPlugin();
  silence(logger);
  logger.register(recorder);

  logger.warn('cache miss');

  assert.deepEqual(recorded, []);
});

test('does not record before register() has been called', () => {
  const logger = new WolterLoggerPlugin();
  silence(logger);

  assert.doesNotThrow(() => TraceContext.run('trace-2', () => logger.error('boom')));
});

test('marks error/fatal as error status, everything else ok', () => {
  const recorded: { status: string }[] = [];
  const recorder = { record: (e: { status: string }) => recorded.push(e) } as unknown as Recorder;
  const logger = new WolterLoggerPlugin();
  silence(logger);
  logger.register(recorder);

  TraceContext.run('trace-3', () => {
    logger.debug('a');
    logger.verbose('b');
    logger.error('c');
    logger.fatal('d');
  });

  assert.deepEqual(
    recorded.map((e) => e.status),
    ['ok', 'ok', 'error', 'error'],
  );
});
