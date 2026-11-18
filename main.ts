// main.ts — the entry's entrypoint: boot the forge, tell the trial suite
// where it listens, then stay up until the suite says it is finished.
//
// The wire, per the competition rules:
//   1. bind an ephemeral port (port 0; never 8080, where the suite listens),
//   2. POST {"port": <the port>} to $MAKEFUN_ENV_URL/register,
//   3. long-poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then exit 0.
// The forge itself lives in app.ts (createApp); this file only owns the
// lifecycle around it. Written from scratch for this entry.

import { createApp } from './app.ts';

/** How long to wait between /done polls when the suite answers quickly. */
const DONE_POLL_GAP_MS = 1000;
/** How long one /done request may hang (the suite long-polls it) before retrying. */
const DONE_REQUEST_TIMEOUT_MS = 30_000;
/** How long to wait between register attempts. */
const REGISTER_RETRY_GAP_MS = 1000;
/** How long to keep retrying the register POST before giving up. */
const REGISTER_BUDGET_MS = 120_000;
/** How long one register attempt may hang before retrying. */
const REGISTER_REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The suite's base URL, without a trailing slash. Exits 1 when unset. */
function suiteBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set (the trial env); exiting\n');
    process.exit(1);
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** Start the forge on an ephemeral port and return the port the kernel picked. */
function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', (err: Error) => {
      reject(new Error(`forge failed to listen: ${describeError(err)}`));
    });
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('forge did not bind a TCP port'));
        return;
      }
      // A server error after startup (a dropped socket, a resource limit)
      // must not crash the trial: log it and keep serving.
      server.on('error', (err: Error) => {
        process.stderr.write(`[entry] forge error after listen: ${describeError(err)}\n`);
      });
      const port = address.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Tell the suite which port the forge listens on. Retries until the suite
 * answers 2xx or the budget runs out; returns true on success.
 */
async function registerWithSuite(base: string, port: number): Promise<boolean> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  for (;;) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return true;
      process.stderr.write(`[entry] register answered HTTP ${res.status}; retrying\n`);
    } catch (err) {
      process.stderr.write(`[entry] register failed (${describeError(err)}); retrying\n`);
    }
    if (Date.now() >= deadline) return false;
    await sleep(REGISTER_RETRY_GAP_MS);
  }
}

/**
 * Poll the suite until it reports the trial is done. A single request may
 * hang while the suite long-polls it; any transport error just retries.
 */
async function waitForSuiteDone(base: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(DONE_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true
        ) {
          return;
        }
      } else {
        process.stderr.write(`[entry] /done answered HTTP ${res.status}; polling again\n`);
      }
    } catch (err) {
      process.stderr.write(`[entry] /done poll failed (${describeError(err)}); polling again\n`);
    }
    await sleep(DONE_POLL_GAP_MS);
  }
}

async function main(): Promise<void> {
  const base = suiteBaseUrl();
  const { port, close } = await listenEphemeral();
  process.stdout.write(`[entry] forge listening on port ${port}\n`);

  if (!(await registerWithSuite(base, port))) {
    process.stderr.write('[entry] suite never accepted the register; exiting\n');
    await close();
    process.exit(1);
  }
  process.stdout.write('[entry] registered with the suite\n');

  await waitForSuiteDone(base);
  process.stdout.write('[entry] suite is done; shutting down\n');
  await close();
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[entry] fatal: ${describeError(err)}\n`);
  process.exit(1);
});
