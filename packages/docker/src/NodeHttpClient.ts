import { homedir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
/**
 * Node/Bun transport for the generated Docker Engine SDK.
 *
 * Delegates Unix sockets, Windows named pipes, TCP and mutual TLS to Effect's
 * scoped Node HTTP agent. Only endpoint selection and API-version negotiation
 * live here; Docker operations and their errors remain generated.
 *
 * SSH transports and Docker CLI contexts are intentionally not emulated: the
 * Engine's HTTP protocol alone cannot implement either of them.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Credentials, DEFAULT_API_BASE_URL, fromApiKey } from "./credentials.ts";
import { DockerProtocol } from "./protocol.ts";

// Keep negotiation capped by the same Engine API version the generated SDK uses.
const LATEST_GENERATED_API = DEFAULT_API_BASE_URL.split("/v").at(-1)!;
const ApiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+$/));
const DaemonVersion = Schema.Struct({
  ApiVersion,
  MinAPIVersion: Schema.optional(ApiVersion),
});

/** Endpoint selection errors; never include credential material in messages. */
export class DockerEndpointError extends Data.TaggedError("DockerEndpointError")<{
  readonly reason:
    | "UnsupportedHost"
    | "InvalidHost"
    | "UnsupportedContext"
    | "InvalidContextConfiguration"
    | "IncompatibleVersion"
    | "InvalidTlsConfiguration";
}> {}

/** Local transport options are independent of the remote Engine API model. */
export const UnixSocketOptions = Schema.Struct({
  socketPath: Schema.String.check(Schema.isNonEmpty()),
  apiBaseUrl: Schema.optional(Schema.String),
  apiVersion: Schema.optional(Schema.Union([Schema.Literal("auto"), ApiVersion])),
});
export type UnixSocketOptions = Schema.Schema.Type<typeof UnixSocketOptions>;

/** TCP endpoint, optionally authenticated with Node's standard TLS options. */
export interface TcpOptions {
  /** HTTP(S) origin, e.g. `https://docker.example.com:2376`. */
  readonly origin: string;
  /** Default: negotiate with the daemon. An explicit version disables probing. */
  readonly apiVersion?: "auto" | string;
  /** Optional bearer token for an authenticated HTTPS Engine proxy. */
  readonly apiKey?: Redacted.Redacted<string>;
  readonly tls?: Pick<
    NodeHttpClient.HttpAgentOptions,
    "ca" | "cert" | "key" | "servername" | "rejectUnauthorized"
  >;
}

/** Docker's documented DOCKER_HOST schemes, with opt-in TLS configuration. */
export interface DockerHostOptions {
  readonly host: string;
  readonly apiVersion?: "auto" | string;
  readonly apiKey?: Redacted.Redacted<string>;
  readonly tls?: TcpOptions["tls"];
}

const parsedVersion = (version: string) =>
  Schema.decodeUnknownEffect(ApiVersion)(version).pipe(
    Effect.mapError(() => new DockerEndpointError({ reason: "IncompatibleVersion" })),
  );

const versionNumber = (value: string) => {
  const [major, minor] = value.split(".").map(Number);
  return major! * 100_000 + minor!;
};

/** Negotiate once per Layer construction, never on every Engine operation. */
const negotiatedCredentials = (origin: string, apiKey?: Redacted.Redacted<string>) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.get(`${origin}/version`);
      const response = yield* client.execute(
        apiKey === undefined
          ? request
          : HttpClientRequest.setHeader(
              request,
              "authorization",
              `Bearer ${Redacted.value(apiKey)}`,
            ),
      );
      const checked = yield* HttpClientResponse.filterStatusOk(response);
      const daemon = yield* Schema.decodeUnknownEffect(DaemonVersion)(yield* checked.json);
      const selected =
        versionNumber(daemon.ApiVersion) < versionNumber(LATEST_GENERATED_API)
          ? daemon.ApiVersion
          : LATEST_GENERATED_API;
      if (
        daemon.MinAPIVersion !== undefined &&
        versionNumber(daemon.MinAPIVersion) > versionNumber(selected)
      ) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "IncompatibleVersion" }));
      }
      return Effect.succeed({ apiBaseUrl: `${origin}/v${selected}`, apiKey });
    }),
  );

const makeLayer = (
  origin: string,
  agent: NodeHttpClient.HttpAgentOptions,
  version: "auto" | string,
  apiKey?: Redacted.Redacted<string>,
) => {
  const http = NodeHttpClient.layerNodeHttpOptions(agent);
  if (version === "auto") {
    return Layer.provideMerge(
      Layer.mergeAll(negotiatedCredentials(origin, apiKey), DockerProtocol),
      http,
    );
  }
  return Layer.mergeAll(
    http,
    fromApiKey({ apiBaseUrl: `${origin}/v${version}`, apiKey }),
    DockerProtocol,
  );
};

/**
 * A complete Effect Layer for the existing Docker Engine operations.
 *
 * The HTTP URL controls only the request path and Host header; the connection
 * itself goes through the provided Unix socket or Windows named pipe.
 *
 * @example
 * import * as Docker from "@distilled.cloud/docker";
 * import * as DockerNode from "@distilled.cloud/docker/NodeHttpClient";
 *
 * const result = yield* Docker.systemVersion2({});
 * // Provide DockerNode.layerUnixSocket({ socketPath: "/var/run/docker.sock" })
 */
export const layerUnixSocket = (options: UnixSocketOptions) => {
  // Preserve the original explicit-base-URL behavior for existing callers.
  if (options.apiBaseUrl !== undefined || options.apiVersion === undefined) {
    return Layer.mergeAll(
      NodeHttpClient.layerNodeHttpOptions({ socketPath: options.socketPath }),
      fromApiKey({ apiBaseUrl: options.apiBaseUrl }),
      DockerProtocol,
    );
  }
  return makeLayer("http://localhost", { socketPath: options.socketPath }, options.apiVersion);
};

/** Connect to a TCP Engine endpoint; TLS verification is enabled by default. */
export const layerTcp = (options: TcpOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* Effect.try({
        try: () => new URL(options.origin),
        catch: () => new DockerEndpointError({ reason: "InvalidHost" }),
      });
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        (options.tls !== undefined && url.protocol !== "https:") ||
        (options.apiKey !== undefined && url.protocol !== "https:")
      ) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidHost" }));
      }
      const version = options.apiVersion ?? "auto";
      if (version !== "auto") yield* parsedVersion(version);
      return makeLayer(url.origin, options.tls ?? {}, version, options.apiKey);
    }),
  );

/**
 * Interpret a Docker Engine endpoint without spawning the Docker CLI.
 * `ssh://` requires an SSH transport and must be handled by a separate adapter.
 */
export const layerDockerHost = (options: DockerHostOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const version = options.apiVersion ?? "auto";
      if (version !== "auto") yield* parsedVersion(version);
      if (options.host.startsWith("unix://")) {
        const socketPath = options.host.slice("unix://".length);
        if (
          !socketPath.startsWith("/") ||
          options.tls !== undefined ||
          options.apiKey !== undefined
        ) {
          return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidHost" }));
        }
        return layerUnixSocket({ socketPath, apiVersion: version });
      }
      if (options.host.startsWith("npipe:////")) {
        if (options.tls !== undefined || options.apiKey !== undefined) {
          return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidHost" }));
        }
        const rest = options.host.slice("npipe:////".length);
        if (!rest.startsWith("./pipe/") || rest.includes("..")) {
          return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidHost" }));
        }
        const socketPath = `\\\\${rest.replaceAll("/", "\\")}`;
        return layerUnixSocket({ socketPath, apiVersion: version });
      }
      if (options.host.startsWith("tcp://")) {
        const origin = `${options.tls === undefined ? "http" : "https"}://${options.host.slice(6)}`;
        return layerTcp({ origin, tls: options.tls, apiVersion: version, apiKey: options.apiKey });
      }
      if (options.host.startsWith("http://") || options.host.startsWith("https://")) {
        return layerTcp({
          origin: options.host,
          tls: options.tls,
          apiVersion: version,
          apiKey: options.apiKey,
        });
      }
      return yield* Effect.fail(new DockerEndpointError({ reason: "UnsupportedHost" }));
    }),
  );

/**
 * Resolve the standard Docker connection variables once at Layer construction.
 * A non-default DOCKER_CONTEXT may refer to an SSH endpoint or a certificate
 * bundle; refusing it is safer than silently targeting the wrong daemon.
 *
 * `env` allows test or fiber-local callers to supply a configuration without
 * modifying global process state. The process environment is the default.
 */
export const layerFromEnvironment = (
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const env = options.env ?? process.env;
      if (
        env.DOCKER_CONTEXT !== undefined &&
        env.DOCKER_CONTEXT !== "default" &&
        env.DOCKER_CONTEXT !== ""
      ) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "UnsupportedContext" }));
      }
      if (env.DOCKER_CONTEXT === "default" && env.DOCKER_HOST) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "UnsupportedContext" }));
      }
      // Docker CLI also persists the selected context in config.json. A
      // library that ignored it could issue writes to the wrong daemon.
      if (!env.DOCKER_HOST && !env.DOCKER_CONTEXT) {
        const fs = yield* FileSystem.FileSystem;
        const configFile = join(env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json");
        const exists = yield* fs.exists(configFile);
        if (exists) {
          const content = yield* fs.readFileString(configFile);
          const config = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ currentContext: Schema.optional(Schema.String) }),
            ),
          )(content).pipe(
            Effect.mapError(
              () => new DockerEndpointError({ reason: "InvalidContextConfiguration" }),
            ),
          );
          if (config.currentContext && config.currentContext !== "default") {
            return yield* Effect.fail(new DockerEndpointError({ reason: "UnsupportedContext" }));
          }
        }
      }
      const host =
        env.DOCKER_HOST ||
        (process.platform === "win32"
          ? "npipe:////./pipe/docker_engine"
          : "unix:///var/run/docker.sock");
      const apiVersion = env.DOCKER_API_VERSION ?? "auto";
      const apiKey = env.DOCKER_API_KEY ? Redacted.make(env.DOCKER_API_KEY) : undefined;
      const tlsVerify =
        env.DOCKER_TLS_VERIFY !== undefined &&
        env.DOCKER_TLS_VERIFY !== "" &&
        env.DOCKER_TLS_VERIFY !== "0";
      if (env.DOCKER_TLS && !tlsVerify) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidTlsConfiguration" }));
      }
      if (!tlsVerify && env.DOCKER_CERT_PATH && host.startsWith("tcp://")) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidTlsConfiguration" }));
      }
      if (!tlsVerify) return layerDockerHost({ host, apiVersion, apiKey });
      if (!host.startsWith("tcp://")) {
        return yield* Effect.fail(new DockerEndpointError({ reason: "InvalidTlsConfiguration" }));
      }
      const fs = yield* FileSystem.FileSystem;
      const certDirectory = env.DOCKER_CERT_PATH || join(homedir(), ".docker");
      const certs = yield* Effect.all(
        ["ca.pem", "cert.pem", "key.pem"].map((name) =>
          fs
            .readFileString(join(certDirectory, name))
            .pipe(
              Effect.mapError(() => new DockerEndpointError({ reason: "InvalidTlsConfiguration" })),
            ),
        ),
        { concurrency: 3 },
      );
      return layerDockerHost({
        host,
        apiVersion,
        apiKey,
        tls: { ca: certs[0]!, cert: certs[1]!, key: certs[2]! },
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
