import { Type, CanActivate } from '@nestjs/common';
import { WolterPlugin } from './plugin.interface';
import { WolterStorageDriver } from './storage.interface';

export interface WolterModuleOptions {
  enabled?: boolean;
  storage?:
    | { driver?: 'sqlite'; path?: string; /** Table name prefix, for sharing a database with the host app. Default 'wolter_'. */ tablePrefix?: string }
    // Bring your own storage (e.g. Postgres) by implementing WolterStorageDriver
    // yourself and passing the instance — Wolter calls instance.close?.() on
    // shutdown the same as it would for its own SqliteStorage.
    | { driver: 'custom'; instance: WolterStorageDriver };
  retention?: string;
  /** When a request counts as slow (ms). `default` applies to every route (500 if unset);
   *  `routes` overrides it per route, keyed by the route template — "GET /reports/:id" for one
   *  method, or "/reports/:id" for all methods. Job thresholds live on BullMQPlugin. */
  thresholds?: {
    default?: number;
    routes?: Record<string, number>;
  };
  // Off by default — headers/bodies are the fields most likely to carry
  // secrets/PII. Headers are still redacted (known-sensitive names) when on.
  capture?: {
    headers?: boolean;
    body?: boolean;
    /** Extra header names to mask, on top of the built-in list (Authorization, Cookie, ...). Case-insensitive. */
    ignoreHeaders?: string[];
    /** Body field names to mask, matched at any nesting depth. Case-insensitive. */
    ignoreBodyFields?: string[];
  };
  events?: {
    /** Per-category cap on stored raw events (requests/exceptions/queries), oldest pruned first. Default 500. */
    retentionCount?: number;
  };
  metrics?: {
    /** Per-category cap on stored metric buckets (one per label per minute), oldest pruned first,
     *  on top of `retention`. Bounds storage size no matter how many distinct labels traffic
     *  produces. Default 100000. */
    maxRowsPerCategory?: number;
  };
  plugins?: WolterPlugin[];
  dashboard?: {
    path?: string;
    enabled?: boolean;
    guard?: Type<CanActivate>;
    /** Serve the dashboard with no guard outside NODE_ENV development/test. Exposes all
     *  captured data to anyone who can reach the path — only for deployments that restrict
     *  access some other way (private network, proxy auth). */
    allowUnauthenticated?: boolean;
  };
}
