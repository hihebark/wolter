import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Every dashboard write (issue triage, data clearing) must carry this header.
// The dashboard is often protected by a cookie-based guard, and a cookie is
// sent on cross-site requests too — but a cross-site <form> can't set custom
// headers, and a cross-site fetch() that does is preflighted and refused
// unless the host's CORS policy explicitly allows it. So the header proves
// the request came from the dashboard page itself, not a page that tricked a
// logged-in viewer's browser into sending it.
export const WRITE_HEADER = 'x-wolter-request';

type RequestLike = { headers?: Record<string, unknown>; user?: unknown };

export function assertWriteRequest(req: RequestLike): void {
  if (req.headers?.[WRITE_HEADER] !== '1') {
    throw new ForbiddenException(`Dashboard writes must send the ${WRITE_HEADER}: 1 header.`);
  }
}

const MAX_NAME = 100;

// The viewer's display name from whatever the host's guard attached to the
// request (Passport and most auth setups use req.user) — undefined when the
// guard sets nothing usable, in which case the dashboard asks for a name.
export function viewerName(req: RequestLike): string | undefined {
  const user = req.user as Record<string, unknown> | undefined;
  if (!user || typeof user !== 'object') return undefined;
  for (const field of ['name', 'username', 'email', 'id', 'sub']) {
    const value = user[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_NAME);
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('Invalid id.');
  return id;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Trimmed string up to `max` chars; '' or null become null. */
export function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BadRequestException(`${field} must be at most ${max} characters.`);
  return trimmed || null;
}

export function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Expected a JSON object body.');
  return body as Record<string, unknown>;
}

export { MAX_NAME };
