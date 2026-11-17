# @distilled.cloud/docker

Effect-native SDK for [docker](https://www.npmjs.com/package/@distilled.cloud/docker).

## Installation

```bash
npm install @distilled.cloud/docker effect
```

## Quick start (Node.js and Bun)

```ts
import * as Docker from "@distilled.cloud/docker";
import * as DockerNode from "@distilled.cloud/docker/NodeHttpClient";
import * as Effect from "effect/Effect";

const Live = DockerNode.layerFromEnvironment();
const containers = Docker.listContainer({ all: true }).pipe(Effect.provide(Live));
Effect.runPromise(containers);
```

Install `@effect/platform-node` alongside `@distilled.cloud/docker` and `effect`
for this Node/Bun transport. The package root remains an independent,
generated HTTP SDK usable with other Effect HTTP clients (including workers).

## Engine endpoints, sockets and versions

`layerFromEnvironment()` recognizes `DOCKER_HOST` (`unix://`, `npipe://` and
`tcp://`), `DOCKER_API_VERSION`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`.
For TLS-verified TCP it loads `ca.pem`, `cert.pem` and `key.pem` from
`DOCKER_CERT_PATH` (or the default `~/.docker` directory). Without an explicit
host, it uses the local socket (`/var/run/docker.sock` on Unix, the Docker
named pipe on Windows).
The connection is made directly to Docker Engine; no Docker CLI executable
is involved.

New endpoint layers probe the daemon's unversioned `/version` endpoint **once
per Layer construction**, use the lower of the daemon's supported API and
the generated SDK's API (`1.56`), and reject incompatible minimum versions.
An explicit version skips the probe. For example:

```ts
import * as DockerNode from "@distilled.cloud/docker/NodeHttpClient";

const local = DockerNode.layerUnixSocket({
  socketPath: "/var/run/docker.sock",
  apiVersion: "auto",
});

const remote = DockerNode.layerTcp({
  origin: "https://docker.example.com:2376",
  tls: { ca: caPem, cert: clientCertPem, key: clientKeyPem },
});

const fromHost = DockerNode.layerDockerHost({
  host: "tcp://docker.example.com:2376",
  tls: { ca: caPem, cert: clientCertPem, key: clientKeyPem },
});
```

Here `caPem`, `clientCertPem` and `clientKeyPem` are PEM strings supplied by
the application. `layerTcp` also accepts an optional redacted `apiKey` for
HTTPS reverse proxies. A bearer token on plain HTTP is rejected.

For compatibility, `layerUnixSocket({ socketPath })` without `apiVersion`
preserves the SDK's original fixed API base URL (`http://localhost/v1.56`).
Opt into negotiation with `apiVersion: "auto"`, or select a version such as
`"1.43"`. Its original `apiBaseUrl` override is also preserved.

Docker CLI context names, SSH hosts and Podman-specific CLI behavior are not
resolved by this HTTP transport. `layerFromEnvironment()` checks
`DOCKER_CONTEXT` and Docker's saved `currentContext`; it fails rather than
silently connecting to a different daemon. Callers using those transports
must supply an Engine-compatible endpoint or use their separate CLI adapter.

## Streaming Engine responses

Use the generated operation normally for typed JSON responses. For Engine
operations that stream logs, tar archives, JSON Lines or progress events, use
`@distilled.cloud/docker/Streams` to avoid buffering the entire response:

```ts
import * as Docker from "@distilled.cloud/docker";
import * as DockerStreams from "@distilled.cloud/docker/Streams";

const bytes = DockerStreams.response(Docker.containerLogs, {
  id: "web", stdout: true, stderr: true, follow: true,
});
// Consume raw Uint8Array chunks, or decode Docker's non-TTY stdcopy frames.
const frames = DockerStreams.demultiplex(bytes);
```

The stream uses the generated request encoder and the same endpoint and
credentials. It preserves Docker's raw bytes (including multiplexed log
frames), and fails on HTTP errors. The optional `demultiplex` stream parser
separates stdin/stdout/stderr, handles split binary frames, and fails on
malformed or incomplete frames. Use raw `bytes` instead for TTY streams.
Neither API performs bidirectional connection hijacking (`attach`/interactive
`exec`) or translates HTTP failures into the generated Docker error union.

## Auth

When composing `DockerProtocol` with `CredentialsFromEnv`, the
`DOCKER_API_BASE_URL` variable selects the API endpoint, and the optional
`DOCKER_API_KEY` supplies a bearer token. `layerFromEnvironment` instead
resolves `DOCKER_HOST` and its transport options, permitting bearer tokens
only over HTTPS. The local Engine socket normally needs no bearer token:
protect it using OS filesystem permissions. Never expose an unauthenticated
Docker Engine endpoint on a public TCP interface.
