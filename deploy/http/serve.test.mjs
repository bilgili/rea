// Tests for serve.mjs. REA is stubbed: `run` is injected, and the MCP factory is a
// counter, so "calls no REA code" means "the factory ran zero times".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/server';
import { WATCHDOG_MS, createHttpDependencies, readHttpConfig, scrubEnv, start } from './serve.mjs';

const TOKEN = 'T'.repeat(8) + 'secret-token-0123456789abcdef';
const HOSTS = ['192.0.2.10', 'rea.example.com'];

// --- helpers -------------------------------------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function makeIo(env = {}) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  const timers = [];
  const io = {
    env,
    proc,
    stderr: [],
    codes: [],
    exits: [],
    timers,
    writeStderr: (text) => io.stderr.push(text),
    setExitCode: (code) => io.codes.push(code),
    exit: (code) => io.exits.push(code),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref: () => (timer.unrefd = true), unrefd: false };
      timers.push(timer);
      return timer;
    },
  };
  return io;
}

/** An HTTP gate on a free port. `calls.factory` counts runs of REA's factory. */
async function startGate(io = makeIo(), { factory } = {}) {
  const port = await freePort();
  const config = { token: TOKEN, hosts: HOSTS, port, bind: '127.0.0.1' };
  const calls = { factory: 0 };
  const deps = createHttpDependencies(config, io);
  const handle = deps.serve(
    factory ??
      (() => {
        calls.factory += 1;
        const server = new McpServer({ name: 'stub-rea', version: '0' });
        server.registerTool('rea_stub', { description: 'stub' }, async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }));
        return server;
      }),
    { onerror: () => io.stderr.push('MCP connection lost\n') },
  );
  await new Promise((resolve) => {
    const probe = () =>
      connect(port, '127.0.0.1')
        .once('connect', function () {
          this.destroy();
          resolve();
        })
        .once('error', () => setTimeout(probe, 5));
    probe();
  });
  return { port, calls, handle, deps };
}

function send(port, { method = 'GET', path = '/mcp', host, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers.accept = 'application/json, text/event-stream';
    }
    if (host !== undefined) headers.host = host;
    const req = request(
      { host: '127.0.0.1', port, method, path, headers, setHost: false, agent: false },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The JSON-RPC message in a JSON or SSE response body. */
const rpc = (text) => JSON.parse(text.includes('data:') ? text.match(/data: (.*)/)[1] : text);

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const OK_HOST = 'rea.example.com';

// --- Selectable MCP transport --------------------------------------------

test('default transport is stdio: runEntrypoint runs, run does not', async () => {
  const io = makeIo({});
  const seen = [];
  await start({
    io,
    loadRea: async () => ({ run: () => seen.push('run'), runEntrypoint: () => seen.push('runEntrypoint') }),
  });
  assert.deepEqual(seen, ['runEntrypoint']);
  assert.deepEqual(io.codes, []);
});

test('unknown transport: one stderr line, exit 2, REA not loaded', async () => {
  const io = makeIo({ REA_MCP_TRANSPORT: 'sse', REA_MCP_AUTH_TOKEN: TOKEN });
  let loaded = false;
  await start({ io, loadRea: async () => (loaded = true) });
  assert.equal(io.stderr.length, 1);
  assert.deepEqual(io.codes, [2]);
  assert.equal(loaded, false);
  assert.ok(!io.stderr.join('').includes(TOKEN));
});

test('http transport: run receives the HTTP dependencies', async () => {
  const io = makeIo({ REA_MCP_TRANSPORT: 'http', REA_MCP_AUTH_TOKEN: TOKEN, REA_MCP_ALLOWED_HOSTS: 'A.example' });
  let deps;
  await start({
    io,
    loadRea: async () => ({
      run: async (d) => ((deps = d), 0),
      runEntrypoint: async (startFn) => io.setExitCode(await startFn()),
    }),
  });
  assert.equal(typeof deps.serve, 'function');
  assert.equal(typeof deps.registerShutdown, 'function');
  assert.equal(deps.env, io.env);
  assert.deepEqual(io.codes, [0]);
});

// --- HTTP configuration is checked before start --------------------------

for (const [name, env] of [
  ['missing token', { REA_MCP_ALLOWED_HOSTS: 'a' }],
  ['short token', { REA_MCP_AUTH_TOKEN: 'x'.repeat(31), REA_MCP_ALLOWED_HOSTS: 'a' }],
]) {
  test(`${name}: exit 1 before REA loads, no token in the error`, async () => {
    const io = makeIo({ REA_MCP_TRANSPORT: 'http', ...env });
    let loaded = false;
    await start({ io, loadRea: async () => (loaded = true) });
    assert.deepEqual(io.codes, [1]);
    assert.equal(loaded, false);
    assert.equal(io.stderr.length, 1);
    if (env.REA_MCP_AUTH_TOKEN) assert.ok(!io.stderr.join('').includes(env.REA_MCP_AUTH_TOKEN));
  });
}

for (const hosts of [undefined, '', ' , ,']) {
  test(`missing allow-list (${JSON.stringify(hosts)}): exit 1 before REA loads`, async () => {
    const env = { REA_MCP_TRANSPORT: 'http', REA_MCP_AUTH_TOKEN: TOKEN };
    if (hosts !== undefined) env.REA_MCP_ALLOWED_HOSTS = hosts;
    const io = makeIo(env);
    let loaded = false;
    await start({ io, loadRea: async () => (loaded = true) });
    assert.deepEqual(io.codes, [1]);
    assert.equal(loaded, false);
    assert.ok(!io.stderr.join('').includes(TOKEN));
  });
}

test('config parse: trims and lowercases hosts, defaults port and bind', () => {
  const r = readHttpConfig({ REA_MCP_AUTH_TOKEN: TOKEN, REA_MCP_ALLOWED_HOSTS: ' A.Example , B.example,' });
  assert.deepEqual(r.value, { token: TOKEN, hosts: ['a.example', 'b.example'], port: 8080, bind: '0.0.0.0' });
  assert.equal(readHttpConfig({ REA_MCP_AUTH_TOKEN: TOKEN, REA_MCP_ALLOWED_HOSTS: 'a', REA_MCP_PORT: 'x' }).ok, false);
});

// --- The token stays out of REA ------------------------------------------

test('scrub removes every REA_MCP_* key before run() is called', async () => {
  const io = makeIo({
    REA_MCP_TRANSPORT: 'http',
    REA_MCP_AUTH_TOKEN: TOKEN,
    REA_MCP_ALLOWED_HOSTS: 'a',
    REA_MCP_PORT: '9',
    REA_MCP_EXTRA: 'x',
    GHIDRA_INSTALL_DIR: '/opt/ghidra',
  });
  let seenAtRun;
  let childEnv;
  await start({
    io,
    loadRea: async () => ({
      run: async (deps) => {
        seenAtRun = Object.keys(deps.env);
        // A child process of REA inherits process.env: model it with a real one.
        const out = spawnSync(process.execPath, ['-p', 'JSON.stringify(Object.keys(process.env))'], {
          env: deps.env,
          encoding: 'utf8',
        });
        childEnv = JSON.parse(out.stdout);
        return 0;
      },
      runEntrypoint: async (startFn) => startFn(),
    }),
  });
  assert.deepEqual(seenAtRun, ['GHIDRA_INSTALL_DIR']);
  assert.ok(!childEnv.some((k) => k.startsWith('REA_MCP_')));
  assert.ok(childEnv.includes('GHIDRA_INSTALL_DIR'));
});

test('real process.env: a grandchild of REA inherits no REA_MCP_* variable', async () => {
  Object.assign(process.env, {
    REA_MCP_TRANSPORT: 'http',
    REA_MCP_AUTH_TOKEN: TOKEN,
    REA_MCP_ALLOWED_HOSTS: 'a',
    REA_MCP_PORT: '9',
    GHIDRA_INSTALL_DIR: '/opt/ghidra',
  });
  const io = { ...makeIo(), env: process.env };
  let names;
  await start({
    io,
    loadRea: async () => ({
      // The stub run() stands for REA: it starts a child that starts a grandchild.
      // Neither gets an explicit env, so both inherit the real process.env.
      run: async () => {
        const inner = 'process.stdout.write(JSON.stringify(Object.keys(process.env)))';
        const outer = `process.stdout.write(require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { encoding: 'utf8' }).stdout)`;
        names = JSON.parse(spawnSync(process.execPath, ['-e', outer], { encoding: 'utf8' }).stdout);
        return 0;
      },
      runEntrypoint: async (startFn) => startFn(),
    }),
  });
  assert.ok(names.includes('GHIDRA_INSTALL_DIR'));
  assert.deepEqual(names.filter((k) => k.startsWith('REA_MCP_')), []);
  assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith('REA_MCP_')), []);
});

test('scrubEnv leaves other keys alone', () => {
  const env = { REA_MCP_AUTH_TOKEN: 'x', REA_ANALYSIS_PROVIDER: 'ghidra', PATH: '/bin' };
  scrubEnv(env);
  assert.deepEqual(env, { REA_ANALYSIS_PROVIDER: 'ghidra', PATH: '/bin' });
});

// --- HTTP requests are authenticated -------------------------------------

test('health probe: 200 ok with no token and no allowed host, no REA code', async () => {
  const { port, calls, handle } = await startGate();
  const r = await send(port, { path: '/healthz', host: 'evil.example' });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'ok');
  assert.equal(calls.factory, 0);
  await handle.close();
});

test('host not allowed or absent: 403, no REA code', async () => {
  const { port, calls, handle } = await startGate();
  for (const host of ['evil.example', 'evil.example:8080', undefined]) {
    const r = await send(port, { path: '/mcp', host, token: TOKEN, body: INIT, method: 'POST' });
    assert.equal(r.status, 403, `host ${host}`);
  }
  assert.equal(calls.factory, 0);
  await handle.close();
});

test('gate order: Host before path before bearer, and /healthz before all', async () => {
  const { port, calls, handle } = await startGate();
  const bad = await send(port, { path: '/admin', host: 'evil.example', token: TOKEN });
  assert.equal(bad.status, 403, 'bad Host on an unknown path: Host check comes first');
  const path = await send(port, { path: '/admin', host: OK_HOST, token: 'wrong' });
  assert.equal(path.status, 404, 'good Host, unknown path, wrong token: path check comes before bearer');
  const health = await send(port, { path: '/healthz', host: 'evil.example' });
  assert.equal(health.status, 200, 'bad Host on /healthz: health probe comes first');
  assert.equal(calls.factory, 0);
  await handle.close();
});

test('host check ignores letter case and port', async () => {
  const { port, handle } = await startGate();
  const r = await send(port, { method: 'POST', host: '192.0.2.10:8721', token: TOKEN, body: INIT });
  assert.equal(r.status, 200);
  const r2 = await send(port, { method: 'POST', host: 'REA.Example.COM', token: TOKEN, body: INIT });
  assert.equal(r2.status, 200);
  await handle.close();
});

test('unknown path: 404, no REA code', async () => {
  const { port, calls, handle } = await startGate();
  for (const path of ['/', '/mcp/x', '/healthz2', '/admin']) {
    const r = await send(port, { path, host: OK_HOST, token: TOKEN });
    assert.equal(r.status, 404, path);
  }
  assert.equal(calls.factory, 0);
  await handle.close();
});

test('missing or wrong token: 401 with WWW-Authenticate, no REA code, no echo', async () => {
  const io = makeIo();
  const { port, calls, handle } = await startGate(io);
  for (const token of [undefined, 'wrong', TOKEN.slice(0, -1), TOKEN + 'x', '']) {
    const r = await send(port, { method: 'POST', host: OK_HOST, token, body: INIT });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assert.ok(!r.text.includes(TOKEN) && !JSON.stringify(r.headers).includes(TOKEN));
  }
  assert.equal(calls.factory, 0);
  assert.ok(!io.stderr.join('').includes(TOKEN));
  await handle.close();
});

test('correct token: initialize then tools/list return the tools', async () => {
  const io = makeIo();
  const { port, handle } = await startGate(io);
  const init = await send(port, { method: 'POST', host: OK_HOST, token: TOKEN, body: INIT });
  assert.equal(init.status, 200);
  assert.ok(rpc(init.text).result);
  const list = await send(port, { method: 'POST', host: OK_HOST, token: TOKEN, body: LIST });
  assert.equal(list.status, 200);
  assert.deepEqual(rpc(list.text).result.tools.map((t) => t.name), ['rea_stub']);
  assert.ok(!io.stderr.join('').includes(TOKEN));
  await handle.close();
});

test('a handler error writes "MCP HTTP request failed", not REA text', async () => {
  const io = makeIo();
  const { port, handle } = await startGate(io, {
    factory: () => {
      throw new Error(`internal ${TOKEN}`);
    },
  });
  await send(port, { method: 'POST', host: OK_HOST, token: TOKEN, body: INIT });
  const err = io.stderr.join('');
  assert.ok(err.includes('MCP HTTP request failed'));
  assert.ok(!err.includes('MCP connection lost'));
  assert.ok(!err.includes('internal'));
  await handle.close();
});

// --- HTTP mode lifecycle -------------------------------------------------

test('serve returns {close} synchronously, before listen completes', async () => {
  const io = makeIo();
  const port = await freePort();
  const deps = createHttpDependencies({ token: TOKEN, hosts: HOSTS, port, bind: '127.0.0.1' }, io);
  const handle = deps.serve(() => new McpServer({ name: 's', version: '0' }));
  assert.equal(typeof handle.then, 'undefined');
  assert.equal(typeof handle.close, 'function');
  await handle.close();
});

test('port in use: one stderr line, exit 1', async () => {
  const busy = createNetServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const io = makeIo();
  const deps = createHttpDependencies(
    { token: TOKEN, hosts: HOSTS, port: busy.address().port, bind: '127.0.0.1' },
    io,
  );
  deps.serve(() => new McpServer({ name: 's', version: '0' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(io.exits, [1]);
  assert.equal(io.stderr.length, 1);
  assert.ok(!io.stderr.join('').includes(TOKEN));
  await new Promise((r) => busy.close(r));
});

test('registerShutdown listens on SIGINT and SIGTERM, never on stdin', () => {
  const io = makeIo();
  const deps = createHttpDependencies({ token: TOKEN, hosts: HOSTS, port: 1, bind: '127.0.0.1' }, io);
  let calls = 0;
  const off = deps.registerShutdown(() => calls++);
  assert.equal(io.proc.listenerCount('SIGINT'), 1);
  assert.equal(io.proc.listenerCount('SIGTERM'), 1);
  assert.equal(io.proc.stdin.listenerCount('end'), 0);
  assert.equal(io.proc.stdin.listenerCount('close'), 0);
  io.proc.stdin.emit('end');
  io.proc.stdin.emit('close');
  assert.equal(calls, 0);
  assert.equal(io.timers.length, 0);
  off();
  assert.equal(io.proc.listenerCount('SIGTERM'), 0);
});

test('first signal arms an unref()d 25 s watchdog that exits 1; later signals do not re-arm', () => {
  const io = makeIo();
  const deps = createHttpDependencies({ token: TOKEN, hosts: HOSTS, port: 1, bind: '127.0.0.1' }, io);
  let calls = 0;
  deps.registerShutdown(() => calls++);
  assert.equal(io.timers.length, 0);
  io.proc.emit('SIGTERM');
  assert.equal(calls, 1);
  assert.equal(io.timers.length, 1);
  assert.equal(io.timers[0].ms, 25_000);
  assert.equal(WATCHDOG_MS, 25_000);
  assert.equal(io.timers[0].unrefd, true);
  assert.deepEqual(io.exits, []);
  io.proc.emit('SIGINT'); // still registered until REA unregisters
  assert.equal(io.timers.length, 1);
  io.timers[0].fn();
  assert.deepEqual(io.exits, [1]);
});

test('registerReload uses SIGHUP', () => {
  const io = makeIo();
  const deps = createHttpDependencies({ token: TOKEN, hosts: HOSTS, port: 1, bind: '127.0.0.1' }, io);
  let calls = 0;
  const off = deps.registerReload(() => calls++);
  io.proc.emit('SIGHUP');
  assert.equal(calls, 1);
  off();
  assert.equal(io.proc.listenerCount('SIGHUP'), 0);
});

test('close stops the listener, then the handler, then resolves; it is idempotent', async () => {
  const { port, handle } = await startGate();
  const first = handle.close();
  assert.equal(handle.close(), first);
  await first;
  await assert.rejects(send(port, { path: '/healthz', host: OK_HOST }), { code: 'ECONNREFUSED' });
});

test('after close starts, a request on an open keep-alive connection never reaches REA', async () => {
  const { port, calls, handle } = await startGate();
  const socket = connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (c) => (received += c));
  const closed = new Promise((r) => socket.on('close', r));
  socket.on('error', () => {});
  await new Promise((r) => socket.once('connect', r));
  socket.write(`GET /healthz HTTP/1.1\r\nHost: ${OK_HOST}\r\nConnection: keep-alive\r\n\r\n`);
  await new Promise((r) => {
    const t = setInterval(() => received.includes('ok') && (clearInterval(t), r()), 5);
  });
  // A request in progress when close starts: Node's server.close() only drops idle
  // connections, so this one needs closeAllConnections().
  const body = JSON.stringify(INIT);
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: ${OK_HOST}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
      `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`,
  );
  await new Promise((r) => setTimeout(r, 30));
  const done = handle.close(); // synchronous step: listener closed, sockets destroyed
  socket.write(body.slice(10));
  await closed;
  await done;
  assert.equal(received.match(/HTTP\/1\.1/g).length, 1, 'only the pre-close response arrived');
  assert.equal(calls.factory, 0);
});

test('shutdown order: HTTP stops before REA closes its session', async () => {
  const { port, handle } = await startGate();
  const order = [];
  await handle.close(); // what REA's shutdown does first
  order.push(await send(port, { path: '/healthz' }).then(() => 'http up', () => 'http down'));
  order.push('session.close'); // what REA's shutdown does second
  assert.deepEqual(order, ['http down', 'session.close']);
});

test('real process with real REA: stdin at EOF keeps serving, SIGTERM exits 0', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname], {
    stdio: ['ignore', 'ignore', 'pipe'], // stdin is /dev/null: EOF at once, as in a container
    env: {
      PATH: process.env.PATH,
      REA_MCP_TRANSPORT: 'http',
      REA_MCP_AUTH_TOKEN: TOKEN,
      REA_MCP_ALLOWED_HOSTS: '127.0.0.1',
      REA_MCP_PORT: String(port),
      REA_MCP_BIND: '127.0.0.1',
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await send(port, { path: '/healthz' }).then((r) => r.status === 200, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, `server did not come up: ${stderr}`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(child.exitCode, null, 'process kept running after stdin EOF');
  const list = await send(port, { method: 'POST', host: '127.0.0.1', token: TOKEN, body: LIST });
  assert.equal(list.status, 200);
  assert.ok(rpc(list.text).result.tools.length > 0);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(!stderr.includes(TOKEN));
});
