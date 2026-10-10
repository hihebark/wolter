import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CachePlugin, defaultKeyLabel } from './cache.plugin';

// Mirrors how real cache-manager/Keyv implementations commonly hold state —
// a private field only accessible with `this` bound to the real instance,
// not a Proxy standing in for it. Regression test for the wrap() bug where
// every method except get() ran with `this` = the Proxy.
class PrivateFieldCache {
  #store = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.#store.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.#store.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.#store.delete(key);
  }
}

test('wrap() binds every method to the real target, not the Proxy', async () => {
  const plugin = new CachePlugin();
  const wrapped = plugin.wrap(new PrivateFieldCache());
  await wrapped.set('a', 1);
  assert.equal(await wrapped.get('a'), 1);
  await wrapped.del('a');
  assert.equal(await wrapped.get('a'), undefined);
});

test('wrap() still records a hit/miss on get()', async () => {
  const events: Array<{ label: string; status: string }> = [];
  const plugin = new CachePlugin();
  plugin.register({
    record: (e: { label: string; status: string }) => events.push({ label: e.label, status: e.status }),
  } as never);
  const wrapped = plugin.wrap(new PrivateFieldCache());
  await wrapped.set('user:123', 'x');
  await wrapped.get('user:123');
  await wrapped.get('user:missing');
  assert.deepEqual(events, [
    { label: 'user', status: 'ok' },
    { label: 'user', status: 'error' },
  ]);
});

// Regression for unbounded label cardinality: keys built from request data
// (URL + query string, tokens) used to become one label per distinct value.
test('defaultKeyLabel groups a key by its namespace, never by request-derived parts', () => {
  assert.equal(defaultKeyLabel('user:123:profile'), 'user');
  assert.equal(defaultKeyLabel('user:banana:profile'), 'user');
  assert.equal(defaultKeyLabel('/products/42?q=shoe'), '/products');
  assert.equal(defaultKeyLabel('/products/banana#x'), '/products');
  assert.equal(defaultKeyLabel('/'), '/');
  assert.equal(defaultKeyLabel('session_a1b2c3'), 'session');
  assert.equal(defaultKeyLabel('cache.v2.users'), 'cache');
  assert.equal(defaultKeyLabel('a1b2c3'), '(unprefixed)');
  assert.equal(defaultKeyLabel(':x'), '(unprefixed)');
});

test('keyLabel overrides the default grouping, and a throwing keyLabel never reaches the caller', async () => {
  const labels: string[] = [];
  const recorder = { record: (e: { label: string }) => labels.push(e.label) } as never;

  const custom = new CachePlugin({ keyLabel: (key) => key.split(':').slice(0, 2).join(':') });
  custom.register(recorder);
  const wrapped = custom.wrap(new PrivateFieldCache());
  await wrapped.get('tenant:acme:user:1');
  assert.deepEqual(labels, ['tenant:acme']);

  const broken = new CachePlugin({ keyLabel: () => { throw new Error('boom'); } });
  broken.register(recorder);
  const wrappedBroken = broken.wrap(new PrivateFieldCache());
  await wrappedBroken.set('k', 1);
  assert.equal(await wrappedBroken.get('k'), 1);
});
