import {
  DynamicModule,
  Inject,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { WOLTER_RECORDER, WOLTER_STORAGE } from './constants';
import { WolterModuleOptions } from './interfaces/options.interface';
import { WolterStorageDriver } from './interfaces/storage.interface';
import { Aggregator } from './aggregation/aggregator';
import { EventLog } from './aggregation/event-log';
import { Recorder } from './recorder';
import { PluginRegistry } from './plugin-registry';
import { SqliteStorage } from './storage/sqlite.storage';
import { WolterHttpInterceptor } from './watchers/http.interceptor';
import { WolterTraceMiddleware } from './watchers/trace.middleware';
import { createDashboardController } from './dashboard/dashboard.controller';

@Injectable()
class WolterLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly aggregator: Aggregator,
    private readonly eventLog: EventLog,
    private readonly pluginRegistry: PluginRegistry,
    @Inject(WOLTER_STORAGE) private readonly storage: WolterStorageDriver,
  ) {}

  async onModuleInit(): Promise<void> {
    this.aggregator.start();
    this.eventLog.start();
    await this.pluginRegistry.bootstrap();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pluginRegistry.shutdown();
    await this.aggregator.stop();
    this.eventLog.stop();
    // Optional on the interface — a driver with nothing to release (no open
    // connection/file handle) can simply not implement it.
    await this.storage.close?.();
    // Releases the one-instance-per-process guard now that this instance
    // has actually torn down — without this, a host app's test suite
    // creating more than one TestingModule (a common Jest pattern: a fresh
    // app per describe/it block, each properly closed afterward) would
    // throw on the second forRoot() call despite every prior instance
    // having shut down cleanly.
    WolterModule.release();
  }
}

@Module({})
export class WolterModule implements NestModule {
  // ponytail: one instance per process is the only supported shape for v0.1 —
  // forRoot() wires a global APP_INTERCEPTOR provider and opens a storage
  // handle, so calling it twice would silently double-count every request.
  // Revisit if a real multi-instance (e.g. per-tenant) need shows up.
  private static registered = false;
  // configure() is a class-level lifecycle hook Nest calls regardless of
  // which DynamicModule shape forRoot() returned — this flag is how it knows
  // whether to actually apply the trace middleware (skipped entirely when
  // enabled: false).
  private static tracingEnabled = false;

  // Called by WolterLifecycle.onApplicationShutdown once an instance has
  // actually torn down — see that method for why this needs to exist.
  static release(): void {
    WolterModule.registered = false;
  }

  configure(consumer: MiddlewareConsumer): void {
    if (!WolterModule.tracingEnabled) return;
    consumer.apply(WolterTraceMiddleware).forRoutes('*');
  }

  static forRoot(options: WolterModuleOptions = {}): DynamicModule {
    const enabled = options.enabled ?? true;
    WolterModule.tracingEnabled = enabled;
    if (!enabled) {
      return { module: WolterModule };
    }

    if (WolterModule.registered) {
      throw new Error(
        '[Wolter] WolterModule.forRoot() was already called once in this process. Import it in a single root module only.',
      );
    }
    WolterModule.registered = true;

    const dashboardEnabled = options.dashboard?.enabled ?? true;
    const dashboardPath = (options.dashboard?.path ?? '/wolter').replace(/^\//, '');

    if (process.env.NODE_ENV === 'production' && dashboardEnabled && !options.dashboard?.guard) {
      throw new Error(
        '[Wolter] Dashboard guard is required in production. Set dashboard.guard in WolterModule.forRoot(), or set dashboard.enabled = false.',
      );
    }

    const providers: Provider[] = [
      {
        provide: WOLTER_STORAGE,
        useFactory: () =>
          options.storage?.driver === 'custom'
            ? options.storage.instance
            : new SqliteStorage(options.storage?.path ?? './wolter.db', options.storage?.tablePrefix),
      },
      {
        provide: Aggregator,
        useFactory: (storage: WolterStorageDriver) => new Aggregator(storage, options.retention),
        inject: [WOLTER_STORAGE],
      },
      {
        provide: EventLog,
        useFactory: (storage: WolterStorageDriver) => new EventLog(storage, options.retention, options.events?.retentionCount ?? 500),
        inject: [WOLTER_STORAGE],
      },
      {
        provide: WOLTER_RECORDER,
        useFactory: (aggregator: Aggregator, eventLog: EventLog) => new Recorder(aggregator, eventLog),
        inject: [Aggregator, EventLog],
      },
      {
        provide: PluginRegistry,
        useFactory: (recorder: Recorder) => new PluginRegistry(options.plugins ?? [], recorder),
        inject: [WOLTER_RECORDER],
      },
      {
        provide: APP_INTERCEPTOR,
        useFactory: (recorder: Recorder) =>
          new WolterHttpInterceptor(
            recorder,
            options.slowQueryThreshold ?? 500,
            dashboardEnabled ? `/${dashboardPath}` : undefined,
            options.capture,
          ),
        inject: [WOLTER_RECORDER],
      },
      WolterLifecycle,
      WolterTraceMiddleware,
    ];

    const controllers = [];
    if (dashboardEnabled) {
      // http/exception are always active — they're built-in watchers, not
      // plugins. Every other category (query/job/cache/...) only shows up in
      // the dashboard if a plugin registered for it actually exists, so an
      // app with no BullMQ/Cache plugin doesn't get an empty Jobs/Cache page.
      const activeCategories = ['http', 'exception', ...new Set((options.plugins ?? []).map((p) => p.category))];
      controllers.push(createDashboardController(dashboardPath, activeCategories, options.dashboard?.guard));
    }

    return {
      module: WolterModule,
      global: true,
      controllers,
      providers,
      exports: [WOLTER_RECORDER],
    };
  }
}
