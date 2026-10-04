import { Recorder, WolterPlugin } from '@wolter/core';

// ponytail: duck-typed against whatever cache manager instance is passed in
// (get(key) -> Promise<value|undefined>) rather than depending on a specific
// @nestjs/cache-manager version, since the wrapper only needs that one method.
interface CacheLike {
  get(key: string): Promise<unknown>;
}

function normalizeKey(key: string): string {
  // user:123 -> user:*, session:abc-def -> session:*
  return key.replace(/:[^:]+$/, ':*');
}

export class CachePlugin implements WolterPlugin {
  name = 'cache';
  category: WolterPlugin['category'] = 'cache';

  private recorder?: Recorder;

  register(recorder: Recorder): void {
    this.recorder = recorder;
  }

  deregister(): void {
    this.recorder = undefined;
  }

  wrap<T extends CacheLike>(cache: T): T {
    const plugin = this;
    return new Proxy(cache, {
      get(target, prop) {
        if (prop === 'get') {
          return async (key: string, ...rest: unknown[]) => {
            const result = await (target.get as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
            plugin.emit(key, result === undefined ? 'error' : 'ok');
            return result;
          };
        }
        // Bound to target, not left to run with `this` = the Proxy (the
        // default when a trap forwards the receiver argument) — a real cache
        // implementation's other methods (set/del/reset/...) commonly close
        // over private (#) fields or WeakMap-backed state, neither of which
        // a Proxy is recognized as a valid `this` for, so an unbound method
        // throws or silently misbehaves the moment it's actually called.
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private emit(key: string, status: 'ok' | 'error'): void {
    if (!this.recorder) return;
    try {
      this.recorder.record({
        plugin: this.name,
        category: 'cache',
        label: normalizeKey(key),
        status,
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
