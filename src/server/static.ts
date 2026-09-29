import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function fileResponse(filePath: string, cacheControl: string): Promise<Response> {
  const body = await readFile(filePath);
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  return new Response(body, {
    headers: { 'Content-Type': type, 'Cache-Control': cacheControl },
  });
}

/**
 * Serves the built SPA from `root`. Hashed files under /assets are cached forever;
 * everything else revalidates. Unknown extension-less paths fall back to index.html
 * so client-side routes survive a reload. Paths that escape `root` get a 404.
 */
export async function serveSpa(root: string, urlPath: string): Promise<Response> {
  const notFound = new Response('Not found', { status: 404 });
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return notFound;
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, '.' + path.posix.normalize('/' + decoded));
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
    return notFound;
  }

  if (await isFile(candidate)) {
    const immutable = decoded.startsWith('/assets/');
    return fileResponse(candidate, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  }

  if (path.extname(decoded) !== '') {
    return notFound;
  }

  const index = path.join(resolvedRoot, 'index.html');
  if (!(await isFile(index))) {
    return notFound;
  }
  return fileResponse(index, 'no-cache');
}
