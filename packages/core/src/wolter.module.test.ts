import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicModule, FactoryProvider } from '@nestjs/common';
import { WolterModule } from './wolter.module';
import { WOLTER_STORAGE } from './constants';
import { WolterStorageDriver } from './interfaces/storage.interface';

// forRoot() only returns a DynamicModule descriptor — providers are plain
// definitions (useFactory closures), never invoked unless something actually
// bootstraps a Nest app around them. Calling it directly here never opens a
// SqliteStorage handle or touches disk, so no cleanup is needed.
test('forRoot() throws on a second call, release() clears the guard for the next one', () => {
  WolterModule.forRoot({ dashboard: { enabled: false } });
  assert.throws(() => WolterModule.forRoot({ dashboard: { enabled: false } }), /already called once in this process/);

  // What onApplicationShutdown calls once an instance actually tears down —
  // see wolter.module.ts for why this needs to exist (a host app's test
  // suite creating more than one TestingModule, each properly closed, would
  // otherwise throw on the second forRoot() despite every prior instance
  // having shut down cleanly).
  WolterModule.release();
  assert.doesNotThrow(() => WolterModule.forRoot({ dashboard: { enabled: false } }));

  WolterModule.release();
});

test('forRoot({ storage: { driver: "custom", instance } }) uses the given driver instead of SqliteStorage, and never opens a file', () => {
  WolterModule.release();
  const instance = {} as WolterStorageDriver;
  const dynamicModule = WolterModule.forRoot({ storage: { driver: 'custom', instance }, dashboard: { enabled: false } }) as DynamicModule;
  const storageProvider = dynamicModule.providers?.find(
    (p): p is FactoryProvider => typeof p === 'object' && 'provide' in p && p.provide === WOLTER_STORAGE,
  );
  assert.equal(storageProvider?.useFactory(), instance);
  WolterModule.release();
});

test('forRoot({ enabled: false }) never engages the guard at all', () => {
  WolterModule.release();
  WolterModule.forRoot({ enabled: false });
  WolterModule.forRoot({ enabled: false });
  assert.doesNotThrow(() => WolterModule.forRoot({ dashboard: { enabled: false } }));
  WolterModule.release();
});

// Never touched — forRoot() only builds a module descriptor (see top of file).
const fakeStorage = {} as WolterStorageDriver;

class TestGuard {
  canActivate(): boolean {
    return true;
  }
}

// Runs fn with NODE_ENV set to `value` (undefined = unset), restoring it after.
function withNodeEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    WolterModule.release();
  }
}

// Regression: the guard used to be required only when NODE_ENV === 'production'
// exactly, so an unset or differently-spelled NODE_ENV served every captured
// request to anonymous clients.
for (const env of [undefined, 'production', 'prod', 'Production', 'staging']) {
  test(`forRoot() refuses an unguarded dashboard when NODE_ENV is ${env === undefined ? 'unset' : `'${env}'`}`, () => {
    withNodeEnv(env, () => {
      assert.throws(() => WolterModule.forRoot({ storage: { driver: 'custom', instance: fakeStorage } }), /Dashboard guard is required/);
    });
  });
}

for (const env of ['development', 'test']) {
  test(`forRoot() allows an unguarded dashboard when NODE_ENV is '${env}'`, () => {
    withNodeEnv(env, () => {
      assert.doesNotThrow(() => WolterModule.forRoot({ storage: { driver: 'custom', instance: fakeStorage } }));
    });
  });
}

test('forRoot() accepts an unguarded dashboard outside development/test only with an explicit opt-in, a guard, or the dashboard off', () => {
  withNodeEnv(undefined, () => {
    assert.doesNotThrow(() => WolterModule.forRoot({ storage: { driver: 'custom', instance: fakeStorage }, dashboard: { allowUnauthenticated: true } }));
  });
  withNodeEnv('production', () => {
    assert.doesNotThrow(() => WolterModule.forRoot({ storage: { driver: 'custom', instance: fakeStorage }, dashboard: { guard: TestGuard } }));
  });
  withNodeEnv('production', () => {
    assert.doesNotThrow(() => WolterModule.forRoot({ storage: { driver: 'custom', instance: fakeStorage }, dashboard: { enabled: false } }));
  });
});
