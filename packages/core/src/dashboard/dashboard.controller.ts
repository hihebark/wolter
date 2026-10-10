import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  NotImplementedException,
  Param,
  Post,
  Query,
  Req,
  Type,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { WOLTER_STORAGE } from '../constants';
import { ClearFilter, IssuePriority, IssueStatus, IssueStore, IssueUpdate, WolterStorageDriver } from '../interfaces/storage.interface';
import { PluginRegistry } from '../plugin-registry';
import { Aggregator } from '../aggregation/aggregator';
import { SqliteStorage } from '../storage/sqlite.storage';
import { renderDashboardHtml } from './dashboard.html';
import { MAX_NAME, assertWriteRequest, bodyObject, oneOf, optionalText, parseId, viewerName } from './write-request';

// Every category the aggregated-bucket endpoint can be asked for. 'runtime'
// is metrics-only (no raw-event capture) so it's absent from
// EVENT_CATEGORIES below — matches EventLog's own RAW_EVENT_CATEGORIES set.
const METRIC_CATEGORIES = new Set(['http', 'query', 'exception', 'job', 'cache', 'runtime']);
const EVENT_CATEGORIES = new Set(['http', 'query', 'exception', 'log']);
const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'resolved', 'ignored'];
const ISSUE_PRIORITIES: readonly IssuePriority[] = ['low', 'medium', 'high', 'critical'];
const MAX_COMMENT = 5000;
const CLEAR_TABLES = ['metrics', 'events'] as const;
const CLEAR_CATEGORIES = [...new Set([...METRIC_CATEGORIES, ...EVENT_CATEGORIES])];

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestException(`${field} must be a timestamp in ms.`);
  return value;
}

// Shared by preview and clear, so what the viewer previewed is exactly what gets deleted.
function parseClearFilter(rawBody: unknown): ClearFilter {
  const body = bodyObject(rawBody);
  if (!Array.isArray(body.tables) || !body.tables.length) throw new BadRequestException('tables must list at least one of: metrics, events.');
  const tables = [...new Set(body.tables.map((t) => oneOf(t, CLEAR_TABLES, 'tables')))];
  const filter: ClearFilter = { tables };
  if (body.category !== undefined && body.category !== null) filter.category = oneOf(body.category, CLEAR_CATEGORIES, 'category');
  const label = optionalText(body.label ?? null, 600, 'label');
  if (label) filter.label = label;
  filter.since = optionalTimestamp(body.since, 'since');
  filter.until = optionalTimestamp(body.until, 'until');
  if (filter.since !== undefined && filter.until !== undefined && filter.since >= filter.until) {
    throw new BadRequestException('since must be before until.');
  }
  if (body.statusCode !== undefined && body.statusCode !== null) {
    if (!Number.isInteger(body.statusCode) || (body.statusCode as number) < 100 || (body.statusCode as number) > 599) {
      throw new BadRequestException('statusCode must be an HTTP status code (100-599).');
    }
    if (tables.includes('metrics')) {
      throw new BadRequestException('A status code filter only applies to raw events — metric buckets don\'t keep per-request status codes. Select raw events only.');
    }
    filter.statusCode = body.statusCode as number;
  }
  return filter;
}

type DashboardRequest = { headers?: Record<string, unknown>; user?: unknown };

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
      private readonly aggregator: Aggregator,
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
    // same consolidation as above. 'log' is queryable too — it's raw-captured
    // for trace correlation, so its rows exist either way. jobs/cache/runtime never had an /events
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
      // The bundled SQLite driver is single-file, single-instance — worth a
      // loud warning if it's what's backing a production deployment. A custom
      // driver (storage: { driver: 'custom' }) is the fix for that warning,
      // so it must not trigger it.
      const retention = await this.storage.retentionInfo();
      return {
        ok: await this.storage.health(),
        sqliteInProduction: process.env.NODE_ENV === 'production' && this.storage instanceof SqliteStorage,
        ...retention,
        plugins: this.pluginRegistry.status(),
        labelOverflow: this.aggregator.overflowStatus(),
      };
    }

    @Get('api/trace/:traceId')
    trace(@Param('traceId') traceId: string) {
      return this.storage.queryEventsByTrace(traceId, 100);
    }

    // ---- Issues: triage state on top of exception groups (see IssueStore) ----

    @Get('api/issues')
    issues(@Query('status') status?: string) {
      return this.issueStore().list(status ? oneOf(status, ISSUE_STATUSES, 'status') : undefined);
    }

    // `viewer` tells the page whether the host's guard identifies the viewer —
    // if not, it asks for a name before commenting.
    @Get('api/issues/:id')
    async issue(@Param('id') id: string, @Req() req: DashboardRequest) {
      const issue = await this.issueStore().get(parseId(id));
      if (!issue) throw new NotFoundException('No such issue.');
      return { ...issue, viewer: viewerName(req) ?? null };
    }

    @Post('api/issues/:id')
    @HttpCode(200)
    async updateIssue(@Param('id') id: string, @Body() rawBody: unknown, @Req() req: DashboardRequest) {
      assertWriteRequest(req);
      const body = bodyObject(rawBody);
      const update: IssueUpdate = {};
      if ('status' in body) update.status = oneOf(body.status, ISSUE_STATUSES, 'status');
      if ('priority' in body) update.priority = body.priority === null ? null : oneOf(body.priority, ISSUE_PRIORITIES, 'priority');
      if ('assignee' in body) update.assignee = optionalText(body.assignee, MAX_NAME, 'assignee');
      const issue = await this.issueStore().update(parseId(id), update, Date.now());
      if (!issue) throw new NotFoundException('No such issue.');
      return issue;
    }

    // The author is the guard-identified viewer when there is one — a typed
    // name is only used when the host's auth doesn't say who's commenting.
    @Post('api/issues/:id/comments')
    async addComment(@Param('id') id: string, @Body() rawBody: unknown, @Req() req: DashboardRequest) {
      assertWriteRequest(req);
      const body = bodyObject(rawBody);
      const text = optionalText(body.body, MAX_COMMENT, 'body');
      if (!text) throw new BadRequestException('body must not be empty.');
      const author = viewerName(req) ?? optionalText(body.author ?? null, MAX_NAME, 'author') ?? 'anonymous';
      const comment = await this.issueStore().addComment(parseId(id), author, text, Date.now());
      if (!comment) throw new NotFoundException('No such issue.');
      return comment;
    }

    // ---- Data clearing: preview counts, then delete the same filter ----

    @Post('api/data/preview')
    @HttpCode(200)
    async previewClear(@Body() rawBody: unknown, @Req() req: DashboardRequest) {
      assertWriteRequest(req);
      return this.clearer()(parseClearFilter(rawBody), true);
    }

    @Post('api/data/clear')
    @HttpCode(200)
    async clear(@Body() rawBody: unknown, @Req() req: DashboardRequest) {
      assertWriteRequest(req);
      const filter = parseClearFilter(rawBody);
      const result = await this.clearer()(filter, false);
      // Matching metric entries still in memory would otherwise be written
      // straight back by the next flush.
      if (filter.tables.includes('metrics') && filter.statusCode === undefined) this.aggregator.discard(filter);
      return result;
    }

    private clearer() {
      if (!this.storage.clearData) throw new NotImplementedException('This storage driver does not support clearing data.');
      return this.storage.clearData.bind(this.storage);
    }

    private issueStore(): IssueStore {
      if (!this.storage.issues) throw new NotImplementedException('This storage driver does not support issues.');
      return this.storage.issues;
    }
  }

  if (guard) {
    UseGuards(guard)(DashboardController);
  }

  return DashboardController;
}
