import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TraceContext } from '../trace-context';

// Platform-agnostic (Express or Fastify) — deliberately untyped req/res
// rather than pulling in an express type dependency this module doesn't
// otherwise need.
@Injectable()
export class WolterTraceMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void): void {
    TraceContext.run(randomUUID(), next);
  }
}
