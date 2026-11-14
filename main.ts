// Entrypoint: one process, one ephemeral port.
//
// Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, POST {port} to
// $MAKEFUN_ENV_URL/register, answer /healthz, then long-poll GET $MAKEFUN_ENV_URL/done until
// {done: true} and exit 0.
//
// Standalone mode (no MAKEFUN_ENV_URL): listen on PORT (default 8080) until killed, so the
// forge can be exercised locally with curl or the kit runner.

import { createAppServer } from './app.ts';
import { Store } from './store.ts';

const REGISTER_RETRY_MS = 500;
const REGISTER_TIMEOUT_MS = 60_000;
const DONE_POLL_MS = 2_000;
const DONE_TIMEOUT_MS = 850_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envUrl(): string | undefined {
  const value = process.env.MAKEFUN_ENV_URL;
  return value && value.length > 0 ? value.replace(/\/$/, '') : undefined;
}

async function register(base: string, port: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return true;
      console.error(`register answered ${response.status}`);
    } catch (err) {
      console.error(`register failed: ${(err as Error).message}`);
    }
    if (Date.now() - started > REGISTER_TIMEOUT_MS) return false;
    await sleep(REGISTER_RETRY_MS);
  }
}

async function waitForDone(base: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch (err) {
      console.error(`done poll failed: ${(err as Error).message}`);
    }
    if (Date.now() - started > DONE_TIMEOUT_MS) return;
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createAppServer(store);
  const base = envUrl();
  const port = base ? 0 : Number.parseInt(process.env.PORT ?? '8080', 10) || 8080;
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`forge listening on http://127.0.0.1:${actualPort}`);
  if (!base) {
    console.log('standalone mode: set MAKEFUN_ENV_URL for trial mode');
    return;
  }
  const registered = await register(base, actualPort);
  if (!registered) {
    console.error('could not register with the trial environment');
    process.exitCode = 1;
    server.close();
    return;
  }
  console.log(`registered with ${base}`);
  await waitForDone(base);
  console.log('trial done, exiting');
  server.close();
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
