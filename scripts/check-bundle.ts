import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Route-level JavaScript budget for the technician screens (mid-range Android on mobile data).
// Counts everything a technician downloads: the entry chunk, the mobile shell and all their
// static imports. Checker-only screens and the desktop shell are lazy chunks, so excluded.
// Run after `npm run build` (npm run check:bundle).

const BUDGET_KB = 110; // gzip [ASSUMPTION]: comfortable for a 3G/4G cold load

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

const dist = path.resolve(import.meta.dirname, '../dist/web');
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8')) as Record<string, ManifestChunk>;

function collect(key: string, seen: Set<string>): void {
  if (seen.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) throw new Error(`manifest has no entry for ${key}`);
  seen.add(key);
  for (const dep of chunk.imports ?? []) collect(dep, seen);
}

function gzKb(keys: Set<string>): number {
  let bytes = 0;
  for (const key of keys) {
    const file = manifest[key]!.file;
    if (file.endsWith('.js')) bytes += gzipSync(readFileSync(path.join(dist, file))).length;
  }
  return bytes / 1024;
}

function route(name: string, roots: string[]): number {
  const keys = new Set<string>();
  for (const root of roots) collect(root, keys);
  const kb = gzKb(keys);
  console.log(`${name.padEnd(28)} ${kb.toFixed(1).padStart(6)} KB gzip  (${keys.size} chunks)`);
  return kb;
}

const technician = route('technician (mobile shell)', ['index.html', 'shells/MobileShell.tsx']);
route('admin technician (+ Work Inv)', ['index.html', 'shells/MobileShell.tsx', 'screens/WorkInv.tsx', 'screens/Invoices.tsx']);
route('master (desktop shell)', ['index.html', 'shells/DesktopShell.tsx', 'screens/WorkInv.tsx', 'screens/Invoices.tsx']);

if (technician > BUDGET_KB) {
  console.error(`\nTechnician route is ${technician.toFixed(1)} KB gzip, over the ${BUDGET_KB} KB budget.`);
  process.exit(1);
}
console.log(`\nTechnician route within the ${BUDGET_KB} KB gzip budget.`);
