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

// Same idea as normalizeQuery, for free-text exception messages instead of
// SQL — without this, "User 123 not found" and "User 456 not found" group as
// two separate issues instead of one, even though they're the same bug.
// ponytail: same regex-over-real-parser tradeoff as normalizeQuery.
export function normalizeMessage(message: string): string {
  return cap(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '?') // uuid
    .replace(/'[^']*'|"[^"]*"/g, '?') // quoted strings
    .replace(/\b\d+(\.\d+)?\b/g, '?'); // numbers
}

// The grouping key shared by Aggregator and EventLog — raw events must be
// keyed identically to aggregate buckets, or "recent occurrences for this
// label" (looked up from the aggregate's label) would never match anything.
// Exceptions fold their (normalized) message into the label alongside the
// class name — grouping by class name alone merges genuinely different bugs
// that just happen to throw the same exception type (e.g. two different
// NotFoundException call sites) into one noisy, meaningless bucket.
export function normalizeLabel(event: { category: string; label: string; meta?: Record<string, unknown> }): string {
  if (event.category === 'query') return normalizeQuery(event.label);
  if (event.category === 'exception') {
    const message = typeof event.meta?.message === 'string' ? event.meta.message : '';
    return message ? cap(`${event.label}: ${normalizeMessage(message)}`) : cap(event.label);
  }
  return cap(event.label);
}
