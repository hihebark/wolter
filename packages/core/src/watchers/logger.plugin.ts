import { ConsoleLogger } from '@nestjs/common';
import { Recorder } from '../recorder';
import { TraceContext } from '../trace-context';
import { WolterPlugin } from '../interfaces/plugin.interface';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

// Extends Nest's own ConsoleLogger (not a from-scratch LoggerService) so
// app.useLogger(loggerPlugin) keeps identical console formatting to the
// default logger — this only adds trace correlation on top, via super.*
// calls, same as Nest's own docs recommend for a custom logger.
//
// Implements both LoggerService (so it can be passed straight to
// app.useLogger(), needed before the app has bootstrapped) and WolterPlugin
// (so PluginRegistry owns its lifecycle) — same instance goes in both
// places. Same pattern as TypeORMPlugin (packages/typeorm), which does the
// same dual-interface trick for TypeORM's own Logger.
//
// ponytail: only records when a request's TraceContext is active — a
// startup/cron log has no trace to correlate into, so recording it would
// just be untraceable noise. Add an untraced-log-capture mode if a real need
// for that shows up.
export class WolterLoggerPlugin extends ConsoleLogger implements WolterPlugin {
  name = 'logger';
  category: WolterPlugin['category'] = 'log';

  private recorder?: Recorder;

  register(recorder: Recorder): void {
    this.recorder = recorder;
  }

  deregister(): void {
    this.recorder = undefined;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('log', 'ok', message, optionalParams);
    super.log(message, ...(optionalParams as [string?]));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', 'error', message, optionalParams);
    super.error(message, ...(optionalParams as [string?, string?]));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', 'ok', message, optionalParams);
    super.warn(message, ...(optionalParams as [string?]));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', 'ok', message, optionalParams);
    super.debug(message, ...(optionalParams as [string?]));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('verbose', 'ok', message, optionalParams);
    super.verbose(message, ...(optionalParams as [string?]));
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', 'error', message, optionalParams);
    super.fatal(message, ...(optionalParams as [string?]));
  }

  private emit(level: Level, status: 'ok' | 'error', message: unknown, optionalParams: unknown[]): void {
    const traceId = TraceContext.current();
    if (!this.recorder || !traceId) return;
    try {
      const last = optionalParams[optionalParams.length - 1];
      this.recorder.record({
        plugin: this.name,
        category: 'log',
        label: typeof message === 'string' ? message : JSON.stringify(message),
        status,
        traceId,
        meta: { level, context: typeof last === 'string' ? last : undefined },
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
