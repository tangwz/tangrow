import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { failure } from './service.js';
import type { Action, LicenseService } from './service.js';

const maxBodyBytes = 4096;
const timeoutMs = 10_000;
const routes = new Map<string, Action>([
  ['/v1/activate', 'activate'], ['/v1/renew', 'renew'], ['/v1/release', 'release'],
]);

function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (declared > maxBodyBytes ||
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      reject(new Error('Invalid request body'));
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBodyBytes) {
        cleanup();
        request.pause();
        reject(new Error('Invalid request body'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch (error) {
        reject(error);
      }
    };

    request.on('data', onData);
    request.once('end', onEnd);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function clientIp(request: IncomingMessage, trustLoopbackProxy: boolean): string {
  const peer = request.socket.remoteAddress ?? '';
  const forwarded = request.headers['x-real-ip'];
  if (trustLoopbackProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') &&
      typeof forwarded === 'string' && isIP(forwarded)) {
    return forwarded;
  }
  return peer;
}

export function createLicenseServer(
  service: LicenseService,
  { trustLoopbackProxy = false, log = console.log }: {
    trustLoopbackProxy?: boolean;
    log?: (line: string) => void;
  } = {},
) {
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const started = performance.now();
    const controller = new AbortController();
    const action = routes.get(request.url ?? '');
    let license: string | null = null;
    let bodyRead = false;

    const send = (result: { status: number; body: object }) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(result.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(bodyRead ? {} : { Connection: 'close' }),
      });
      response.end(JSON.stringify(result.body));
      const outcome = 'error' in result.body ? result.body.error : 'ok';
      log(JSON.stringify({ license, action: action ?? 'unknown', result: outcome, durationMs: Math.round(performance.now() - started) }));
    };
    const deadline = setTimeout(() => {
      controller.abort();
      send(failure(bodyRead ? 'upstream_unavailable' : 'bad_request'));
    }, timeoutMs);
    response.once('close', () => {
      clearTimeout(deadline);
      controller.abort();
    });
    request.on('error', () => controller.abort());

    try {
      if (!action || request.method !== 'POST') {
        send(failure('bad_request'));
        return;
      }
      const source = clientIp(request, trustLoopbackProxy);
      if (action === 'activate' && !service.allowActivationFrom(source)) {
        send(failure('rate_limited'));
        return;
      }

      let input: unknown;
      try {
        input = await readJson(request, controller.signal);
        bodyRead = true;
      } catch {
        send(failure('bad_request'));
        return;
      }
      send(await service.handle(action, input, controller.signal, id => { license = id.slice(0, 8); }, source));
    } catch {
      send(failure('upstream_unavailable'));
    }
  }

  const server = createServer({
    headersTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    connectionsCheckingInterval: 1000,
  }, (request, response) => { void handle(request, response); });
  server.setTimeout(timeoutMs, socket => socket.destroy());
  return server;
}
