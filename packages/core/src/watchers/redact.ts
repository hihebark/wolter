const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key']);

// Applied unconditionally whenever headers are captured at all — cheap
// insurance against the most common secret-carrying headers, even though the
// caller already opted in to header capture. `extraNames` is the app's own
// additional denylist (e.g. capture.ignoreHeaders), merged on top.
export function redactHeaders(headers: Record<string, unknown> | undefined, extraNames: string[] = []): Record<string, unknown> {
  const names = new Set(SENSITIVE_HEADER_NAMES);
  for (const n of extraNames) names.add(n.toLowerCase());
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = names.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

// Masks named fields anywhere in a body (any nesting depth) before it's
// stored — e.g. capture.ignoreBodyFields: ['password'] masks
// { user: { password } } too, not just top-level keys.
export function redactFields(value: unknown, fieldNames: string[] = []): unknown {
  if (!fieldNames.length) return value;
  const names = new Set(fieldNames.map((n) => n.toLowerCase()));
  // `stack` holds only the current chain of ancestors being walked (pushed
  // on the way in, popped on the way out) — not every object ever seen, so
  // two sibling fields that happen to point at the same shared-but-acyclic
  // object are walked normally, and only a genuine cycle (an object that is
  // its own ancestor) hits the check below. Without this, a circular
  // reference in req.body recurses until the stack overflows — caught by
  // the interceptor's outer try/catch so it doesn't crash the request, but
  // it burns real CPU first and silently drops the capture.
  const walk = (v: unknown, stack: Set<object>): unknown => {
    if (Array.isArray(v)) {
      if (stack.has(v)) return '[circular]';
      stack.add(v);
      const out = v.map((item) => walk(item, stack));
      stack.delete(v);
      return out;
    }
    if (v && typeof v === 'object') {
      if (stack.has(v as object)) return '[circular]';
      stack.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        out[key] = names.has(key.toLowerCase()) ? '[redacted]' : walk(val, stack);
      }
      stack.delete(v as object);
      return out;
    }
    return v;
  };
  return walk(value, new Set());
}

const MAX_BODY_BYTES = 8192;

// Bodies and SQL bound parameters are arbitrary shape — beyond the
// field-name redaction above, only a size cap is applied so one huge payload
// can't bloat storage. ponytail: fixed cap, add a maxBodyBytes option if teams need it.
export function truncateBody(value: unknown, maxBytes = MAX_BODY_BYTES): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= maxBytes) return value;
  return { truncated: true, preview: json.slice(0, maxBytes) };
}
