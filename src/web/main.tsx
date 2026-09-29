import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { en } from './i18n/en.ts';

type ServerState = 'waking' | 'ready' | 'unreachable';

// Render Free cold-starts in about a minute, so poll /api/health with a long overall deadline.
const WARMUP_DEADLINE_MS = 90_000;
const RETRY_DELAY_MS = 3_000;

async function waitForServer(signal: AbortSignal): Promise<ServerState> {
  const deadline = Date.now() + WARMUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store', signal });
      if (res.ok) return 'ready';
    } catch (err) {
      if (signal.aborted) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return 'unreachable';
}

function App() {
  const [state, setState] = useState<ServerState>('waking');

  useEffect(() => {
    const controller = new AbortController();
    waitForServer(controller.signal).then(setState, () => {});
    return () => controller.abort();
  }, []);

  const message =
    state === 'ready' ? en.serverReady : state === 'waking' ? en.serverWaking : en.serverUnreachable;

  return (
    <main className="app">
      <h1>{en.appName}</h1>
      <p className={state === 'ready' ? 'status-ok' : 'status-waking'} role="status">
        {message}
      </p>
      <p>{en.scaffoldNotice}</p>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
