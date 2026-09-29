import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.ts';

describe('health endpoint', () => {
  const app = createApp();

  it('returns ok without caching', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('sends security headers', async () => {
    const res = await app.request('/api/health');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('static SPA serving', () => {
  let base: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'ahc-static-'));
    const root = path.join(base, 'web');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(base, 'secret.txt'), 'outside the web root');
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>t</title>');
    await writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
    app = createApp({ staticRoot: root });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('serves hashed assets as immutable', async () => {
    const res = await app.request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for client routes', async () => {
    const res = await app.request('/work-inv/pending');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('404s missing files that have an extension', async () => {
    const res = await app.request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('never serves files outside the web root', async () => {
    const res = await app.request('/..%2Fsecret.txt');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('outside the web root');
  });
});
