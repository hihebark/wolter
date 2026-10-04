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
  slowQueryThreshold?: number;
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
  plugins?: WolterPlugin[];
  dashboard?: {
    path?: string;
    enabled?: boolean;
    guard?: Type<CanActivate>;
  };
}
