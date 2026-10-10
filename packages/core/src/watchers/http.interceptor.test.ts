import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastValueFrom, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { WolterHttpInterceptor } from './http.interceptor';
import { Recorder } from '../recorder';

function contextFor(url: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url, route: { path: url.split('?')[0] } }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as unknown as ExecutionContext;
}

const handler: CallHandler = { handle: () => of('ok') };

test('ignores the dashboard mount path even behind a global prefix', () => {
  const recorded: string[] = [];
  const recorder = { record: (e: { label: string }) => recorded.push(e.label) } as unknown as Recorder;
  const interceptor = new WolterHttpInterceptor(recorder, 500, '/wolter');

  interceptor.intercept(contextFor('/api/wolter/api/http?range=1h'), handler).subscribe();
  interceptor.intercept(contextFor('/wolter'), handler).subscribe();

  assert.deepEqual(recorded, []);
});

test('still records real app routes that merely contain the dashboard segment as a substring', () => {
  const recorded: string[] = [];
  const recorder = { record: (e: { label: string }) => recorded.push(e.label) } as unknown as Recorder;
  const interceptor = new WolterHttpInterceptor(recorder, 500, '/wolter');

  interceptor.intercept(contextFor('/api/wolterish/report'), handler).subscribe();

  assert.deepEqual(recorded, ['GET /api/wolterish/report']);
});

test('records real app routes normally when no ignore prefix is configured', () => {
  const recorded: string[] = [];
  const recorder = { record: (e: { label: string }) => recorded.push(e.label) } as unknown as Recorder;
  const interceptor = new WolterHttpInterceptor(recorder, 500);

  interceptor.intercept(contextFor('/api/v1/organization/permissions'), handler).subscribe();

  assert.deepEqual(recorded, ['GET /api/v1/organization/permissions']);
});

test('a matched route carries its own method/path for backend-side route resolution', () => {
  const recorded: Array<{ routeMethod?: string; routePath?: string }> = [];
  const recorder = {
    record: (e: { routeMethod?: string; routePath?: string }) => recorded.push({ routeMethod: e.routeMethod, routePath: e.routePath }),
  } as unknown as Recorder;
  const interceptor = new WolterHttpInterceptor(recorder, 500);

  interceptor.intercept(contextFor('/users/:id'), handler).subscribe();

  assert.deepEqual(recorded, [{ routeMethod: 'GET', routePath: '/users/:id' }]);
});

test('an unmatched route (no req.route) gets no route identity', () => {
  const recorded: Array<{ routeMethod?: string; routePath?: string }> = [];
  const recorder = {
    record: (e: { routeMethod?: string; routePath?: string }) => recorded.push({ routeMethod: e.routeMethod, routePath: e.routePath }),
  } as unknown as Recorder;
  const interceptor = new WolterHttpInterceptor(recorder, 500);
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/does-not-exist' }),
      getResponse: () => ({ statusCode: 404 }),
    }),
  } as unknown as ExecutionContext;

  interceptor.intercept(context, handler).subscribe();

  assert.deepEqual(recorded, [{ routeMethod: undefined, routePath: undefined }]);
});

// Per-route thresholds: the matched route template picks its own threshold,
// falling back to the global default.
function contextForRoute(method: string, routePath: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method, url: routePath, route: { path: routePath } }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as unknown as ExecutionContext;
}

async function statusOf(interceptor: WolterHttpInterceptor, method: string, routePath: string): Promise<string | undefined> {
  const slowHandler: CallHandler = { handle: () => of('ok').pipe(delay(5)) };
  let status: string | undefined;
  const recorder = { record: (e: { category: string; status: string }) => { if (e.category === 'http') status = e.status; } } as unknown as Recorder;
  (interceptor as unknown as { recorder: Recorder }).recorder = recorder;
  await lastValueFrom(interceptor.intercept(contextForRoute(method, routePath), slowHandler));
  return status;
}

test('a route threshold keyed "METHOD /path" applies only to that method', async () => {
  const interceptor = new WolterHttpInterceptor({} as Recorder, 10_000, undefined, undefined, { 'GET /reports/:id': 1 });
  assert.equal(await statusOf(interceptor, 'GET', '/reports/:id'), 'slow');
  assert.equal(await statusOf(interceptor, 'POST', '/reports/:id'), 'ok'); // falls back to the 10s default
});

test('a route threshold keyed "/path" applies to every method; other routes keep the default', async () => {
  const interceptor = new WolterHttpInterceptor({} as Recorder, 10_000, undefined, undefined, { '/reports/:id': 1 });
  assert.equal(await statusOf(interceptor, 'POST', '/reports/:id'), 'slow');
  assert.equal(await statusOf(interceptor, 'GET', '/users/:id'), 'ok');
});

test('a method-specific threshold wins over a path-wide one', async () => {
  const interceptor = new WolterHttpInterceptor({} as Recorder, 1, undefined, undefined, { '/reports/:id': 1, 'GET /reports/:id': 10_000 });
  assert.equal(await statusOf(interceptor, 'GET', '/reports/:id'), 'ok');
  assert.equal(await statusOf(interceptor, 'DELETE', '/reports/:id'), 'slow');
});
