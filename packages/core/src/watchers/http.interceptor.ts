import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Recorder } from '../recorder';
import { TraceContext } from '../trace-context';
import { redactFields, redactHeaders, truncateBody } from './redact';

// Keeps the "<Name>: <message>" header plus the first `frames` lines after
// it. Counting from the end of the message, not the top of the stack, keeps a
// long multi-line message from pushing every real frame out — the throw site
// (see normalize-query.ts's throwSite) is read from those frames.
function truncateStack(stack: string, message: string, frames = 20): string {
  const messageAt = message ? stack.indexOf(message) : -1;
  if (messageAt === -1) return stack.split('\n').slice(0, frames).join('\n');
  const headerEnd = messageAt + message.length;
  return stack.slice(0, headerEnd) + stack.slice(headerEnd).split('\n').slice(0, frames + 1).join('\n');
}

@Injectable()
export class WolterHttpInterceptor implements NestInterceptor {
  // Matched as a path *segment*, not just a prefix: a global prefix
  // (app.setGlobalPrefix('api')) or URI versioning puts extra segments in
  // front of the dashboard's mount path, so the dashboard's own traffic
  // (e.g. /api/wolter/api/http) would otherwise never match a plain
  // startsWith('/wolter') check and would get recorded as real app traffic,
  // polluting/evicting it in storage.
  private readonly ignorePathRegex?: RegExp;

  constructor(
    private readonly recorder: Recorder,
    private readonly slowThreshold: number,
    ignorePathPrefix?: string,
    private readonly capture?: { headers?: boolean; body?: boolean; ignoreHeaders?: string[]; ignoreBodyFields?: string[] },
    // Per-route overrides of slowThreshold, keyed "METHOD /route/:template"
    // (one method) or "/route/:template" (any method) — the matched route
    // template, so the key is the same for every request to that endpoint.
    private readonly routeThresholds: Record<string, number> = {},
  ) {
    if (ignorePathPrefix) {
      const segment = ignorePathPrefix.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      this.ignorePathRegex = new RegExp(`(^|/)${segment}(/|$)`);
    }
  }

  private thresholdFor(method: string, routePath: string | undefined): number {
    if (routePath) {
      const exact = this.routeThresholds[`${method} ${routePath}`] ?? this.routeThresholds[routePath];
      if (exact !== undefined) return exact;
    }
    return this.slowThreshold;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    if (this.ignorePathRegex) {
      const req = context.switchToHttp().getRequest();
      const pathname: string = req.url?.split('?')[0] ?? '';
      if (this.ignorePathRegex.test(pathname)) return next.handle();
    }

    const start = Date.now();
    const record = (status: 'ok' | 'error', err?: unknown) => {
      try {
        const req = context.switchToHttp().getRequest();
        const res = context.switchToHttp().getResponse();
        const duration = Date.now() - start;
        // On the error path the exception filter hasn't run yet at this point,
        // so res.statusCode is still whatever it was before the throw — read
        // the real code off the exception itself instead (HttpException.getStatus()
        // is public API; anything else is an unhandled error, which Nest maps to 500).
        const statusCode =
          status === 'error'
            ? typeof (err as { getStatus?: () => number })?.getStatus === 'function'
              ? (err as { getStatus: () => number }).getStatus()
              : 500
            : res?.statusCode;
        // ponytail: unmatched routes (404s, probes) collapse into one bounded
        // label instead of the raw URL — grouping by raw path would let an
        // attacker balloon bucket/row count by hitting arbitrary paths.
        const meta: Record<string, unknown> = { method: req.method, path: req.url };
        // Headers/body are opt-in (off by default) — they're the fields most
        // likely to carry secrets/PII. Headers are redacted even when on;
        // ignoreHeaders/ignoreBodyFields let the app mask its own additional
        // sensitive names on top of the built-in header denylist.
        if (this.capture?.headers) meta.headers = redactHeaders(req.headers, this.capture.ignoreHeaders);
        if (this.capture?.body && req.body && Object.keys(req.body).length) {
          meta.body = truncateBody(redactFields(req.body, this.capture.ignoreBodyFields));
        }
        const traceId = TraceContext.current();
        this.recorder.record({
          plugin: 'core',
          category: 'http',
          label: req.route?.path ? `${req.method} ${req.route.path}` : `${req.method} (unmatched)`,
          duration,
          status: status === 'error' ? 'error' : duration > this.thresholdFor(req.method, req.route?.path) ? 'slow' : 'ok',
          statusCode,
          traceId,
          // Only matched routes get a backend-owned route identity — an
          // unmatched request (404, probe) isn't a real endpoint worth saving.
          ...(req.route?.path ? { routeMethod: req.method, routePath: req.route.path } : {}),
          meta,
          timestamp: Date.now(),
        });

        // Exception recording lives here rather than in a separate global
        // @Catch() filter deliberately: NestJS's ExceptionsHandler picks
        // exactly ONE matching filter per exception (first match wins), so a
        // second bare @Catch() filter can silently steal — or lose to — a
        // host app's own catch-all filter (confirmed by reading Nest's own
        // ExceptionsHandler/selectExceptionFilterMetadata source; this isn't
        // hypothetical). An interceptor never competes for response
        // ownership, so this can never affect what the host app returns.
        // Tradeoff: exceptions thrown by Guards (which run before
        // interceptors) aren't visible here — acceptable, since "never touch
        // the response" matters more than catching every last exception.
        if (status === 'error') {
          this.recorder.record({
            plugin: 'core',
            category: 'exception',
            label: err instanceof Error ? err.constructor.name : 'UnknownError',
            status: err instanceof HttpException ? 'ok' : 'error',
            traceId,
            meta: {
              path: req.url,
              method: req.method,
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error && err.stack ? truncateStack(err.stack, err.message) : undefined,
            },
            timestamp: Date.now(),
          });
        }
      } catch {
        // Zero-impact guarantee.
      }
    };

    return next.handle().pipe(
      tap({
        next: () => record('ok'),
        error: (err) => record('error', err),
      }),
    );
  }
}
