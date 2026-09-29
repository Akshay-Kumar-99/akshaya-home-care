import { spawn, type ChildProcess } from 'node:child_process';

// Runs the API server (with --watch) and the Vite dev server together, cross-platform,
// without a shell or extra dependencies. Ctrl+C stops both.
const node = process.execPath;
const children: ChildProcess[] = [
  spawn(node, ['--watch', '--env-file-if-exists=.env', 'src/server/index.ts'], { stdio: 'inherit' }),
  spawn(node, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code) => stopAll(code ?? 0));
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
