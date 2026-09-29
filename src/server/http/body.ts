import type { Context } from 'hono';
import type { z } from 'zod';

/** Parses and validates a JSON body. Returns null if the body is missing or invalid. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Like readJson, but returns the validation messages so forms can show them. */
export async function readJsonOrIssues<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; issues: Array<{ path: string; message: string }> }> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined): value is string {
  return !!value && UUID.test(value);
}
