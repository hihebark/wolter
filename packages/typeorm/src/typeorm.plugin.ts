import { Recorder, TraceContext, WolterPlugin, truncateBody } from '@wolter/core';
import { Logger } from 'typeorm';

// Implements both TypeORM's Logger interface (so it can be passed directly as
// `logger:` in DataSource options, needed before the app has bootstrapped)
// and WolterPlugin (so WolterModule's registry owns its lifecycle). The same
// instance goes in both places — see examples/with-typeorm.
//
// ponytail: TypeORM's Logger interface only hands us a duration for queries
// that already crossed maxQueryExecutionTime (logQuerySlow) — ordinary
// queries record with duration=0. Wrapping QueryRunner.query directly would
// give exact per-query timing; not worth it until slow-query grouping proves
// too coarse in practice.
export class TypeORMPlugin implements WolterPlugin, Logger {
  name = 'typeorm';
  category: WolterPlugin['category'] = 'query';

  private recorder?: Recorder;

  // Plugins own their own config (see NodePlugin's { interval }) rather than
  // reading WolterModuleOptions.capture — captureParameters is off by
  // default since bound params can carry the same secrets/PII a request body
  // would.
  constructor(private options: { captureParameters?: boolean } = {}) {}

  register(recorder: Recorder): void {
    this.recorder = recorder;
  }

  deregister(): void {
    this.recorder = undefined;
  }

  logQuery(query: string, parameters?: unknown[]): void {
    this.emit(query, 0, 'ok', parameters);
  }

  logQueryError(_error: string | Error, query: string, parameters?: unknown[]): void {
    this.emit(query, 0, 'error', parameters);
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
    this.emit(query, time, 'slow', parameters);
  }

  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}

  private emit(query: string, duration: number, status: 'ok' | 'error' | 'slow', parameters?: unknown[]): void {
    if (!this.recorder) return; // not registered yet — e.g. schema sync before Wolter bootstrap
    try {
      this.recorder.record({
        plugin: this.name,
        category: 'query',
        label: query,
        duration,
        status,
        traceId: TraceContext.current(),
        meta: this.options.captureParameters && parameters?.length ? { parameters: truncateBody(parameters) } : undefined,
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
