// A label is a grouping identifier, not a payload — unlike HTTP body/query
// parameters (capped by truncateBody at 8192 bytes before capture), nothing
// bounded label length at all. A label becomes a SQL primary-key component
// (storage/sqlite.storage.ts's metrics table) and an in-memory Map key
// (Aggregator's buffer) for as long as its window stays open, so an
// unbounded one — a bulk INSERT's generated SQL, or an exception message
// that interpolates a large JSON.stringify(req.body) — is unbounded storage
// and memory growth. Applied both before normalization (so the regex work
// below is bounded too, not just the final stored size) and as a last step,
// since normalization only ever shrinks a string, never grows it, but the
// exception branch's concatenation does.
const MAX_LABEL_LENGTH = 500;
function cap(value: string): string {
  return value.length > MAX_LABEL_LENGTH ? value.slice(0, MAX_LABEL_LENGTH) + '…' : value;
}

// ponytail: regex-based normalization, not a real SQL parser — collapses most
// literals fine but can misfire on quoted strings containing escaped quotes.
// Upgrade to a proper SQL tokenizer if slow-query grouping looks wrong in practice.
export function normalizeQuery(sql: string): string {
  return cap(sql)
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?');
}

// One V8 stack frame: "at fn (file:line:col)" or "at file:line:col".
const FRAME = /^\s+at (?:(.+?) \()?(.+?):\d+:\d+\)?$/;

// Where an exception was thrown: the first stack frame in the app's own code
// (dependencies and Node internals skipped), as "fn (file)" — no line/column,
// so small edits above the throw don't split one bug into a new group.
// Returns undefined when no such frame exists (no stack, or a stack made only
// of library frames).
//
// The stack starts with "<Name>: <message>", and the message is
// request-controlled — it can contain lines that look like frames. Parsing
// only starts after the message, so an attacker can't forge the throw site.
export function throwSite(stack: string, message: string): string | undefined {
  const messageAt = message ? stack.indexOf(message) : 0;
  // Message not found (e.g. the stack was cut inside a long message): can't
  // tell its lines from real frames, so don't guess.
  if (messageAt === -1) return undefined;
  const frames = stack.slice(messageAt + message.length).split('\n');
  for (const line of frames) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const file = match[2].replace(/^file:\/\//, '');
    if (file.includes('node_modules') || file.startsWith('node:') || file.startsWith('internal/') || file === '<anonymous>') continue;
    const cwd = process.cwd() + '/';
    const relative = file.startsWith(cwd) ? file.slice(cwd.length) : file;
    const fn = (match[1] ?? '<anonymous>').replace(/^async /, '');
    return `${fn} (${relative})`;
  }
  return undefined;
}

// The grouping key shared by Aggregator and EventLog — raw events must be
// keyed identically to aggregate buckets, or "recent occurrences for this
// label" (looked up from the aggregate's label) would never match anything.
//
// Exceptions group by class + throw site, never by message: the message often
// carries request data ("No product named <whatever the client sent>"), so
// grouping by it would let any client create unlimited groups. Throw sites are
// bounded by the app's own code. The message itself stays on each raw event
// (meta.message), so the dashboard still shows it per occurrence. With no
// usable stack, the class name alone is the group.
//
// Every other category's label is set by its emitter (route template,
// normalized SQL, cache key namespace, ...) and only length-capped here;
// Aggregator's per-window label cap is the backstop for any that misbehave.
// 'log' is raw on purpose — it's the log line shown in the trace waterfall,
// and Aggregator never aggregates it.
export function normalizeLabel(event: { category: string; label: string; meta?: Record<string, unknown> }): string {
  if (event.category === 'query') return normalizeQuery(event.label);
  if (event.category === 'exception') {
    const stack = typeof event.meta?.stack === 'string' ? event.meta.stack : '';
    const message = typeof event.meta?.message === 'string' ? event.meta.message : '';
    const site = stack ? throwSite(stack, message) : undefined;
    return cap(site ? `${event.label} at ${site}` : event.label);
  }
  return cap(event.label);
}
