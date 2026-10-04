import { test } from 'node:test';
import assert from 'node:assert/strict';
import { of } from 'rxjs';
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
