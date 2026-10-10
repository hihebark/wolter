import { Recorder, WolterPlugin } from '@wolter/core';

// ponytail: duck-typed against whatever cache manager instance is passed in
// (get(key) -> Promise<value|undefined>) rather than depending on a specific
// @nestjs/cache-manager version, since the wrapper only needs that one method.
interface CacheLike {
  get(key: string): Promise<unknown>;
}

export interface CachePluginOptions {
  /** Maps a cache key to the label it's grouped under on the dashboard. Defaults to
   *  defaultKeyLabel (the key's namespace). Supply one for finer groups — e.g. keep a
   *  second segment — but never return parts of the key that come from request data,
   *  or every distinct value becomes its own group. */
  keyLabel?: (key: string) => string;
}

// Groups a key by its namespace — the part the app's code chose, before any
// value that may come from the request. Only the app knows its key format, so
// the default is deliberately coarse; keyLabel can refine it.
//   'user:123:profile'     -> 'user'
//   '/products/42?q=shoe'  -> '/products'   (URL-style keys, e.g. CacheInterceptor's)
//   'session_a1b2c3'       -> 'session'
//   'a1b2c3'               -> '(unprefixed)' (no namespace: the whole key may be a request value)
export function defaultKeyLabel(key: string): string {
  const path = key.split(/[?#]/)[0];
  let namespace: string;
  if (path.includes(':')) namespace = path.slice(0, path.indexOf(':'));
  else if (path.startsWith('/')) namespace = '/' + path.slice(1).split('/')[0];
  else if (/[_.-]/.test(path)) namespace = path.slice(0, path.search(/[_.-]/));
  else namespace = '';
  return namespace || '(unprefixed)';
}

export class CachePlugin implements WolterPlugin {
  name = 'cache';
  category: WolterPlugin['category'] = 'cache';

  private recorder?: Recorder;

  constructor(private readonly options: CachePluginOptions = {}) {}

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
      // Inside the try: a throwing keyLabel must not reach the host's cache call.
      const label = (this.options.keyLabel ?? defaultKeyLabel)(key);
      this.recorder.record({
        plugin: this.name,
        category: 'cache',
        label,
        status,
        timestamp: Date.now(),
      });
    } catch {
      // Zero-impact guarantee.
    }
  }
}
