import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Docker from "@distilled.cloud/docker";
import * as DockerNode from "@distilled.cloud/docker/NodeHttpClient";
import * as DockerStreams from "@distilled.cloud/docker/Streams";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect, it } from "vitest";

/**
 * Exercise the actual Node HTTP agent over a private Unix socket, not a
 * mocked Effect HttpClient. This test never contacts the host Docker daemon.
 */
const engineHandler =
  (
    requests: Array<string>,
    version: { readonly api: string; readonly minimum: string } = {
      api: "1.44",
      minimum: "1.24",
    },
  ) =>
  (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/version") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ApiVersion: version.api, MinAPIVersion: version.minimum }));
    } else if (request.url?.endsWith("/_ping")) {
      response.writeHead(200, { "content-type": "text/plain" }).end("OK");
    } else if (request.url?.startsWith("/v1.44/containers/log-demo/logs?")) {
      response.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      response.write(Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 0, 255]));
      response.end(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 42]));
    } else if (request.url?.endsWith("/containers/not-found/json")) {
      response
        .writeHead(404, { "content-type": "application/json" })
        .end('{"message":"No such container: not-found"}');
    } else {
      response.writeHead(500).end("Unexpected Engine request");
    }
  };

const mockEngine = (
  requests: Array<string>,
  version?: { readonly api: string; readonly minimum: string },
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      // CI can set TMPDIR to a deeply nested path. Unix sockaddr.sun_path is
      // typically capped at 108 bytes, so sockets need a short absolute path.
      const dir = await mkdtemp("/tmp/dsdk-");
      const socketPath = join(dir, "engine.sock");
      const server = createServer(engineHandler(requests, version));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      return { dir, server, socketPath };
    }),
    ({ dir, server }) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }),
  );

const unixTest = process.platform === "win32" ? it.skip : it;

const mockTcpEngine = (requests: Array<string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer(engineHandler(requests));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

unixTest("reuses the Engine SDK over a Unix socket with typed HTTP errors", async () => {
  const requests: Array<string> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { socketPath } = yield* mockEngine(requests);
        const defaultLayer = DockerNode.layerUnixSocket({ socketPath });
        expect(yield* Docker.pingSystem({}).pipe(Effect.provide(defaultLayer))).toBe("OK");

        const failure = yield* Docker.containerInspect({ id: "not-found" }).pipe(
          Effect.provide(defaultLayer),
          Effect.flip,
        );
        expect(failure._tag).toBe("NotFound");

        const customLayer = DockerNode.layerUnixSocket({
          socketPath,
          apiBaseUrl: "http://not-a-real-host.invalid/v1.43",
        });
        expect(yield* Docker.pingSystem({}).pipe(Effect.provide(customLayer))).toBe("OK");
      }),
    ),
  );

  expect(requests).toEqual([
    "GET /v1.56/_ping",
    "GET /v1.56/containers/not-found/json",
    "GET /v1.43/_ping",
  ]);
});

unixTest(
  "negotiates the Engine API version once per layer and reuses the generated operations",
  async () => {
    const requests: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { socketPath } = yield* mockEngine(requests);
          const layer = DockerNode.layerDockerHost({ host: `unix://${socketPath}` });
          yield* Effect.gen(function* () {
            expect(yield* Docker.pingSystem({})).toBe("OK");
            expect(yield* Docker.pingSystem({})).toBe("OK");
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
    expect(requests).toEqual(["GET /version", "GET /v1.44/_ping", "GET /v1.44/_ping"]);
  },
);

unixTest("rejects a daemon requiring a newer API than the generated SDK supports", async () => {
  const requests: Array<string> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { socketPath } = yield* mockEngine(requests, {
          api: "1.61",
          minimum: "1.57",
        });
        const failure = yield* Effect.flip(
          Docker.pingSystem({}).pipe(
            Effect.provide(DockerNode.layerDockerHost({ host: `unix://${socketPath}` })),
          ),
        );
        expect(failure).toMatchObject({
          _tag: "DockerEndpointError",
          reason: "IncompatibleVersion",
        });
      }),
    ),
  );
  expect(requests).toEqual(["GET /version"]);
});

unixTest("caps a newer daemon API to the SDK's generated version", async () => {
  const requests: Array<string> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { socketPath } = yield* mockEngine(requests, {
          api: "1.58",
          minimum: "1.40",
        });
        expect(
          yield* Docker.pingSystem({}).pipe(
            Effect.provide(DockerNode.layerUnixSocket({ socketPath, apiVersion: "auto" })),
          ),
        ).toBe("OK");
      }),
    ),
  );
  expect(requests).toEqual(["GET /version", "GET /v1.56/_ping"]);
});

it("rejects unsupported SSH and invalid TCP endpoints without silently falling back", async () => {
  const ssh = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerDockerHost({
            host: "ssh://deploy@example.com",
          }),
        ),
      ),
    ),
  );
  expect(ssh).toMatchObject({ _tag: "DockerEndpointError", reason: "UnsupportedHost" });

  const withCredentials = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerTcp({
            origin: "http://user:password@localhost:2375",
          }),
        ),
      ),
    ),
  );
  expect(withCredentials).toMatchObject({ _tag: "DockerEndpointError", reason: "InvalidHost" });

  const token = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerTcp({
            origin: "http://127.0.0.1:2375",
            apiKey: Redacted.make("example-sensitive-token"),
          }),
        ),
      ),
    ),
  );
  expect(token).toMatchObject({ _tag: "DockerEndpointError", reason: "InvalidHost" });
  expect(JSON.stringify(token)).not.toContain("example-sensitive-token");
});

it("uses the same generated SDK over TCP with negotiated and explicit API versions", async () => {
  const requests: Array<string> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* mockTcpEngine(requests);
        expect(
          yield* Docker.pingSystem({}).pipe(Effect.provide(DockerNode.layerTcp({ origin }))),
        ).toBe("OK");
        expect(
          yield* Docker.pingSystem({}).pipe(
            Effect.provide(
              DockerNode.layerDockerHost({
                host: origin.replace("http://", "tcp://"),
                apiVersion: "1.43",
              }),
            ),
          ),
        ).toBe("OK");
      }),
    ),
  );
  expect(requests).toEqual(["GET /version", "GET /v1.44/_ping", "GET /v1.43/_ping"]);
});

unixTest(
  "honors DOCKER_HOST and DOCKER_API_VERSION without consulting the Docker CLI",
  async () => {
    const requests: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { socketPath } = yield* mockEngine(requests);
          const layer = DockerNode.layerFromEnvironment({
            env: { DOCKER_HOST: `unix://${socketPath}`, DOCKER_API_VERSION: "1.42" },
          });
          expect(yield* Docker.pingSystem({}).pipe(Effect.provide(layer))).toBe("OK");
        }),
      ),
    );
    expect(requests).toEqual(["GET /v1.42/_ping"]);
  },
);

it("resolves a TCP DOCKER_HOST from the environment with version negotiation", async () => {
  const requests: Array<string> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* mockTcpEngine(requests);
        const layer = DockerNode.layerFromEnvironment({
          env: { DOCKER_HOST: origin.replace("http://", "tcp://") },
        });
        expect(yield* Docker.pingSystem({}).pipe(Effect.provide(layer))).toBe("OK");
      }),
    ),
  );
  expect(requests).toEqual(["GET /version", "GET /v1.44/_ping"]);
});

it("fails closed for unsupported contexts and incomplete TLS configuration", async () => {
  const context = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerFromEnvironment({
            env: { DOCKER_CONTEXT: "production", DOCKER_HOST: "unix:///var/run/docker.sock" },
          }),
        ),
      ),
    ),
  );
  expect(context).toMatchObject({ _tag: "DockerEndpointError", reason: "UnsupportedContext" });

  const defaultContextConflict = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerFromEnvironment({
            env: { DOCKER_CONTEXT: "default", DOCKER_HOST: "tcp://example.com:2375" },
          }),
        ),
      ),
    ),
  );
  expect(defaultContextConflict).toMatchObject({
    _tag: "DockerEndpointError",
    reason: "UnsupportedContext",
  });

  const tls = await Effect.runPromise(
    Effect.flip(
      Docker.pingSystem({}).pipe(
        Effect.provide(
          DockerNode.layerFromEnvironment({
            env: { DOCKER_HOST: "tcp://127.0.0.1:2376", DOCKER_TLS_VERIFY: "1" },
          }),
        ),
      ),
    ),
  );
  expect(tls).toMatchObject({ _tag: "DockerEndpointError", reason: "InvalidTlsConfiguration" });
});

it("does not ignore the active Docker context from DOCKER_CONFIG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsdk-config-"));
  try {
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ currentContext: "production", auths: {} }),
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        Docker.pingSystem({}).pipe(
          Effect.provide(
            DockerNode.layerFromEnvironment({
              env: { DOCKER_CONFIG: dir },
            }),
          ),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "DockerEndpointError", reason: "UnsupportedContext" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

unixTest("streams unmodified Docker Engine bytes using the generated request schema", async () => {
  const requests: Array<string> = [];
  const chunks = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { socketPath } = yield* mockEngine(requests);
        return yield* DockerStreams.response(Docker.containerLogs, {
          id: "log-demo",
          stdout: true,
          stderr: true,
        }).pipe(
          Stream.runCollect,
          Effect.provide(DockerNode.layerUnixSocket({ socketPath, apiVersion: "1.44" })),
        );
      }),
    ),
  );
  expect(Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toEqual([
    1, 0, 0, 0, 0, 0, 0, 2, 0, 255, 2, 0, 0, 0, 0, 0, 0, 1, 42,
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/v1.44/containers/log-demo/logs?");
  const frames = await Effect.runPromise(
    DockerStreams.demultiplex(Stream.fromIterable(chunks)).pipe(Stream.runCollect),
  );
  expect(frames).toEqual([
    { channel: "stdout", bytes: Uint8Array.from([0, 255]) },
    { channel: "stderr", bytes: Uint8Array.from([42]) },
  ]);
});

it("decodes Docker frames across split headers and payloads without losing binary data", async () => {
  const bytes = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 3, 0, 255, 42, 2, 0, 0, 0, 0, 0, 0, 1, 19]);
  const split = [
    bytes.slice(0, 3),
    bytes.slice(3, 7),
    bytes.slice(7, 9),
    bytes.slice(9, 12),
    bytes.slice(12, 16),
    bytes.slice(16),
  ];
  const frames = await Effect.runPromise(
    Stream.runCollect(DockerStreams.demultiplex(Stream.fromIterable(split))),
  );
  expect(frames).toEqual([
    { channel: "stdout", bytes: Uint8Array.from([0, 255, 42]) },
    { channel: "stderr", bytes: Uint8Array.from([19]) },
  ]);
});

it("rejects malformed, oversized and truncated Docker multiplexed frames", async () => {
  const invalid = [
    { bytes: [7, 0, 0, 0, 0, 0, 0, 0], reason: "InvalidHeader" },
    { bytes: [1, 1, 0, 0, 0, 0, 0, 0], reason: "InvalidHeader" },
    { bytes: [1, 0, 0, 0, 1, 0, 0, 1], reason: "FrameTooLarge" },
    { bytes: [1, 0, 0, 0, 0, 0, 0, 2, 42], reason: "TruncatedFrame" },
    { bytes: [1, 0, 0], reason: "TruncatedFrame" },
  ] as const;
  for (const { bytes, reason } of invalid) {
    const error = await Effect.runPromise(
      Effect.flip(
        DockerStreams.demultiplex(Stream.fromIterable([Uint8Array.from(bytes)])).pipe(
          Stream.runCollect,
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "DockerFrameError", reason });
  }
});
