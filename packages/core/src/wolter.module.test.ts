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
