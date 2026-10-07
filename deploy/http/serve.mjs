#!/usr/bin/env node
// Entry point for the rea-mcp image. Serves REA (rea-agents) over stdio (default)
// or over Streamable HTTP behind a bearer-token gate.
//
// Seam: REA's run(dependencies) takes `serve` and `registerShutdown` as injected
// dependencies. HTTP mode injects its own, so REA itself stays unpatched.
// Why injection: a fork of REA would need a rebase on each release; run(dependencies) is
// not a documented interface, so the exact version pin and serve.test.mjs guard it.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createMcpHandler, validateHostHeader } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

export const WATCHDOG_MS = 25_000;
const MIN_TOKEN_LENGTH = 32;
const PREFIX = 'REA_MCP_';

/** Validate the HTTP configuration. The messages are fixed text: they never carry the token. */
export function readHttpConfig(env) {
  const token = env.REA_MCP_AUTH_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, message: `REA_MCP_AUTH_TOKEN must have at least ${MIN_TOKEN_LENGTH} characters` };
  }
  const hosts = (env.REA_MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) {
    return { ok: false, message: 'REA_MCP_ALLOWED_HOSTS must list at least one host name' };
  }
  const portText = env.REA_MCP_PORT ?? '8080';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return { ok: false, message: 'REA_MCP_PORT must be a TCP port number from 1 to 65535' };
  }
  const bind = env.REA_MCP_BIND || '0.0.0.0';
  return { ok: true, value: { token, hosts, port, bind } };
}

/** Delete every REA_MCP_* key. REA and its child processes read process.env directly. */
export function scrubEnv(env) {
  for (const key of Object.keys(env)) if (key.startsWith(PREFIX)) delete env[key];
}

const digest = (text) => createHash('sha256').update(text).digest();

/** The request gate (design D4). Returns the HTTP server and a close() for it. */
function createGate({ token, hosts }, forward) {
  const tokenDigest = digest(token);
  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
    res.end(body);
  };
  return (req, res) => {
    let path = '';
    try {
      path = new URL(req.url ?? '', 'http://gate').pathname;
    } catch {
      // unparseable target: path stays '' and gets 404 after the Host check
    }
    // 1. Health probe: no token, no Host check, no REA code.
    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, 'ok');
    // 2. DNS-rebinding guard: the SDK check ignores letter case and port.
    if (!validateHostHeader(req.headers.host, hosts).ok) return reply(res, 403, 'Forbidden');
    // 3. One MCP path.
    if (path !== '/mcp') return reply(res, 404, 'Not Found');
    // 4. Bearer token, compared as SHA-256 digests in constant time.
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    if (!match || !timingSafeEqual(digest(match[1]), tokenDigest)) {
      return reply(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    // 5. Everything else is REA's.
    return forward(req, res);
  };
}

/**
 * Build the `dependencies` object that run() takes (design D3).
 * `io` carries every side effect, so tests can stub them: env, proc, writeStderr,
 * setExitCode, exit, setTimeout.
 */
export function createHttpDependencies(config, io) {
  const serve = (factory) => {
    // REA's onerror says "MCP connection lost", which is wrong for an HTTP request.
    const onerror = () => io.writeStderr('MCP HTTP request failed\n');
    const handler = createMcpHandler(factory, { onerror });
    const forward = toNodeHandler(handler, { onerror });
    let closing;
    // requireHostHeader off: Node would answer 400 itself; the gate answers 403.
    const server = createServer({ requireHostHeader: false }, createGate(config, forward));
    let listening = false;
    server.on('error', (error) => {
      // Only an error before 'listening' is a listen failure. Later errors are request faults.
      if (listening) return onerror(error);
      io.writeStderr(`rea-mcp: cannot listen on ${config.bind}:${config.port} (${error.code ?? 'error'})\n`);
      io.exit(1);
    });
    server.on('listening', () => {
      listening = true;
      if (closing) server.close(); // close() ran while a hostname bind was pending
    });
    server.listen(config.port, config.bind);
    // Return at once: REA calls serve() without await, and a listen error arrives later.
    return {
      close: () =>
        (closing ??= (async () => {
          // One synchronous step: stop the listener and drop every connection, so no
          // request on an old keep-alive connection reaches the handler.
          const stopped = new Promise((resolve) => server.close(() => resolve()));
          server.closeAllConnections();
          await handler.close();
          await stopped;
        })()),
    };
  };

  // SIGINT and SIGTERM only. Standard input is at EOF at once in a container.
  const registerShutdown = (handler) => {
    let armed = false;
    const onSignal = () => {
      if (!armed) {
        armed = true;
        const timer = io.setTimeout(() => {
          io.writeStderr('rea-mcp: shutdown did not finish in time\n');
          io.exit(1);
        }, WATCHDOG_MS);
        timer.unref();
      }
      handler();
    };
    // once(), not on(): a second signal finds no listener and gets Node's default action,
    // an immediate exit. This is a deliberate escape hatch for an operator.
    io.proc.once('SIGINT', onSignal);
    io.proc.once('SIGTERM', onSignal);
    return () => {
      io.proc.off('SIGINT', onSignal);
      io.proc.off('SIGTERM', onSignal);
    };
  };

  const registerReload = (handler) => {
    io.proc.on('SIGHUP', handler);
    return () => io.proc.off('SIGHUP', handler);
  };

  return {
    env: io.env,
    serve,
    writeStderr: io.writeStderr,
    setExitCode: io.setExitCode,
    registerShutdown,
    registerReload,
  };
}

/**
 * Pick the transport (design D2). `loadRea()` returns REA's { run, runEntrypoint };
 * it is called only after validation, so a bad configuration never starts REA.
 */
export async function start({ io, loadRea }) {
  const transport = io.env.REA_MCP_TRANSPORT ?? 'stdio';
  if (transport === 'stdio') {
    const { runEntrypoint } = await loadRea();
    return runEntrypoint();
  }
  if (transport !== 'http') {
    io.writeStderr('rea-mcp: REA_MCP_TRANSPORT must be "stdio" or "http"\n');
    return io.setExitCode(2);
  }
  const config = readHttpConfig(io.env);
  if (!config.ok) {
    io.writeStderr(`rea-mcp: ${config.message}\n`);
    return io.setExitCode(1);
  }
  scrubEnv(io.env);
  const { run, runEntrypoint } = await loadRea();
  // runEntrypoint keeps REA's own redaction of an unexpected startup failure.
  return runEntrypoint(
    () => run(createHttpDependencies(config.value, io)),
    io.writeStderr,
    io.setExitCode,
  );
}

const realIo = () => ({
  env: process.env,
  proc: process,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => process.exit(code),
  setTimeout,
});

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(realpathSync(entryPath)).href === import.meta.url) {
  // rea-agents has no exports map, so the deep import resolves.
  await start({ io: realIo(), loadRea: () => import('rea-agents/dist/main.js') });
}
