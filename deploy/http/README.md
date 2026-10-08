# REA MCP over HTTP

This directory holds a wrapper that serves REA (`rea-agents`) over MCP (Model Context Protocol).
The wrapper uses stdio or authenticated Streamable HTTP.
It calls `run()` of REA with its own `serve` and `registerShutdown` dependencies.
It changes no REA source file.
The image installs `rea-agents` 4.1.0 from npm at the exact version in `package.json`.
It does not use the REA source of this repository.

## Environment variables

| Variable                | Default   | Rule                                                                                   |
| ----------------------- | --------- | -------------------------------------------------------------------------------------- |
| `REA_MCP_TRANSPORT`     | `stdio`   | `stdio` or `http`. Any other value: one error line, exit code 2.                       |
| `REA_MCP_AUTH_TOKEN`    | none      | HTTP only. Required. At least 32 characters.                                           |
| `REA_MCP_ALLOWED_HOSTS` | none      | HTTP only. Required. Comma-separated `Host` names. Letter case and port do not matter. |
| `REA_MCP_PORT`          | `8080`    | HTTP only. TCP (Transmission Control Protocol) port.                                   |
| `REA_MCP_BIND`          | `0.0.0.0` | HTTP only. Bind address.                                                               |

A wrong HTTP configuration makes the process exit with code 1 before REA starts.
The error text never contains the token.

## Request gate

The HTTP server handles each request in this order:

1. `GET /healthz` answers `200` with the text `ok`. It needs no token.
2. A `Host` header that is absent or not in the allow-list gets `403`.
3. A path other than `/mcp` gets `404`.
4. A missing or wrong `Authorization: Bearer <token>` header gets `401`.
5. All other requests go to REA.

The gate runs before the server reads a request body.
The server compares SHA-256 digests of the token with `crypto.timingSafeEqual`.

## Token limitation

The entry point deletes every `REA_MCP_*` variable from `process.env` before REA starts.
Ghidra and the programs that REA captures therefore do not inherit the token.
The scrub does not hide the token from code that runs as the same user.
That code can read `/proc/<pid>/environ`, which keeps the start environment.
Treat anyone who can run code in the container as a holder of the token.

## Lifecycle

The process stops only on `SIGINT` or `SIGTERM`. Closed standard input does not stop it.
On shutdown, the HTTP server stops and closes all connections first.
Then REA closes its session.
A watchdog exits the process with code 1 if shutdown takes more than 25 seconds.
Give the container a stop grace period of at least 30 seconds.

## Build and run

The image contains JDK 21, Node.js 22, and Ghidra 12.1.4.
The build checks the SHA-256 digest of the Ghidra download and runs `serve.test.mjs`.

```bash
docker build -t rea-mcp deploy/http

docker run -d --init --name rea-mcp -p 8080:8080 \
  -e REA_MCP_TRANSPORT=http \
  -e REA_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e REA_MCP_ALLOWED_HOSTS=localhost \
  -e REA_ANALYSIS_PROVIDER=ghidra \
  -e GHIDRA_HEADLESS_MAXMEM=12G \
  -v /path/to/binaries:/binaries:ro \
  rea-mcp
```

The variable `GHIDRA_HEADLESS_MAXMEM` sets the maximum Java heap of Ghidra. The default is 2 GiB.
The image sets `GHIDRA_INSTALL_DIR=/opt/ghidra`.
Ghidra 12.1.4 needs an x86-64 Linux host.

## Test

```bash
cd deploy/http
npm ci
node --test serve.test.mjs
```

Use Node.js 22.19 or later in the 22 line.
The tests replace REA with a stub, except one test that starts the real process.

## Upgrade

Change the exact version of `rea-agents` in `package.json`.
Run `npm install` and `node --test serve.test.mjs`.
The entry point relies on the `run(dependencies)` seam of REA.
It is not a documented interface, so the tests must pass after each upgrade.
