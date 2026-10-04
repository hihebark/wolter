import { BadRequestException, CanActivate, Controller, Get, Header, Inject, Param, Query, Type, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { WOLTER_STORAGE } from '../constants';
import { WolterStorageDriver } from '../interfaces/storage.interface';
import { PluginRegistry } from '../plugin-registry';
import { renderDashboardHtml } from './dashboard.html';

// Every category the aggregated-bucket endpoint can be asked for. 'runtime'
// is metrics-only (no raw-event capture) so it's absent from
// EVENT_CATEGORIES below — matches EventLog's own RAW_EVENT_CATEGORIES set.
const METRIC_CATEGORIES = new Set(['http', 'query', 'exception', 'job', 'cache', 'runtime']);
const EVENT_CATEGORIES = new Set(['http', 'query', 'exception']);

// A dynamic @Controller(path) is created per app instance because the
// dashboard path is configurable — plain class decoration can't take a
// runtime value, so we build the class in a factory instead. The guard is
// attached the same way: calling UseGuards() as a plain function on the
// class works exactly like the decorator syntax, using only Nest's public API.
// version: VERSION_NEUTRAL opts out of the host app's URI versioning (e.g.
// enableVersioning({ defaultVersion: '1' })) — a dashboard isn't a versioned
// API resource, and without this a host with default versioning enabled
// would silently require /v1/<path> with no indication why /<path> 404s.
// (A global prefix like setGlobalPrefix('api') still applies regardless —
// that's the host's own explicit, unambiguous choice, nothing to opt out of.)
export function createDashboardController(path: string, activeCategories: string[], guard?: Type<CanActivate>): Type<unknown> {
  @Controller({ path, version: VERSION_NEUTRAL })
  class DashboardController {
    constructor(
      @Inject(WOLTER_STORAGE) private readonly storage: WolterStorageDriver,
      private readonly pluginRegistry: PluginRegistry,
    ) {}

    @Get()
    @Header('Content-Type', 'text/html')
    index(): string {
      return renderDashboardHtml(activeCategories);
    }

    // Replaces what used to be 6 near-identical routes (api/http, api/queries,
    // api/exceptions, api/jobs, api/cache, api/runtime) — each was the same
    // 2-line body differing only in which literal category string it passed
    // through. category is real user input now that it's a param rather
    // than baked into the route, so it's validated against the actual set
    // of categories the storage layer knows how to group — an unrecognized
    // one is a 400, not a silently-empty result set.
    @Get('api/metrics')
    metrics(@Query('category') category: string, @Query('range') range = '1h', @Query('search') search?: string) {
      if (!METRIC_CATEGORIES.has(category)) {
        throw new BadRequestException(`Unknown category '${category}'. Expected one of: ${[...METRIC_CATEGORIES].join(', ')}.`);
      }
      return this.storage.query(category, range, search);
    }

    // Replaces api/http/events, api/queries/events, api/exceptions/events —
    // same consolidation as above. jobs/cache/runtime never had an /events
    // route (they're aggregate-only categories, see EventLog's own
    // RAW_EVENT_CATEGORIES), so EVENT_CATEGORIES is deliberately the
    // narrower set, not all of METRIC_CATEGORIES.
    @Get('api/events')
    events(@Query('category') category: string, @Query('label') label: string, @Query('range') range = '1h') {
      if (!EVENT_CATEGORIES.has(category)) {
        throw new BadRequestException(`Unknown category '${category}'. Expected one of: ${[...EVENT_CATEGORIES].join(', ')}.`);
      }
      return this.storage.queryEvents(category, label, range, 50);
    }

    @Get('api/health')
    async health() {
      // v0.1 only ships the SQLite driver (single-file, single-instance) —
      // worth a loud warning if it's what's backing a production deployment.
      const retention = await this.storage.retentionInfo();
      return {
        ok: await this.storage.health(),
        sqliteInProduction: process.env.NODE_ENV === 'production',
        ...retention,
        plugins: this.pluginRegistry.status(),
      };
    }

    @Get('api/trace/:traceId')
    trace(@Param('traceId') traceId: string) {
      return this.storage.queryEventsByTrace(traceId, 100);
    }
  }

  if (guard) {
    UseGuards(guard)(DashboardController);
  }

  return DashboardController;
}
