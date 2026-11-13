/**
 * Explicitly opt-in Docker CLI end-to-end test. Every mutating call is scoped
 * to a disposable Docker-in-Docker daemon, never the default host socket.
 *
 * Requires:
 *   DISTILLED_DOCKER_E2E=1
 *   DISTILLED_DOCKER_E2E_DAEMON=<exact isolated daemon hostname>
 *   DOCKER_HOST=tcp://127.0.0.1:<forwarded isolated port>
 * The isolated daemon must already contain alpine:3.22.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import * as Docker from "../src/cli.ts";

const enabled = process.env.DISTILLED_DOCKER_E2E === "1";

it.skipIf(!enabled)(
  "creates, inspects, and cleans resources through generated Docker CLI operations",
  async () => {
    const endpoint = process.env.DOCKER_HOST;
    const expectedDaemon = process.env.DISTILLED_DOCKER_E2E_DAEMON;
    if (
      !/^tcp:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? "") ||
      expectedDaemon === undefined ||
      expectedDaemon === "SICOTI-DEV"
    ) {
      throw new Error(
        "Docker SDK integration requires a named, localhost-only Docker-in-Docker daemon",
      );
    }

    const result = await Effect.runPromise(
      Docker.dockerInfo({
        flags: { format: "{{.Name}}" },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    if (result.stdout.trim() !== expectedDaemon) {
      throw new Error(
        "Refusing to modify Docker resources: daemon identity does not match isolated test target",
      );
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const network = `distilled-e2e-network-${suffix}`;
    const volume = `distilled-e2e-volume-${suffix}`;
    const container = `distilled-e2e-container-${suffix}`;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const createdNetwork = yield* Effect.acquireRelease(
            Docker.networkCreate({ args: [network] }),
            () => Docker.networkRm({ args: [network] }).pipe(Effect.ignore),
          );
          expect(createdNetwork.exitCode).toBe(0);
          const inspectedNetwork = yield* Docker.networkInspect({ args: [network] });
          expect(inspectedNetwork[0]?.Name).toBe(network);

          const createdVolume = yield* Effect.acquireRelease(
            Docker.volumeCreate({ args: [volume] }),
            () => Docker.volumeRm({ args: [volume] }).pipe(Effect.ignore),
          );
          expect(createdVolume.exitCode).toBe(0);
          const inspectedVolume = yield* Docker.volumeInspect({ args: [volume] });
          expect(inspectedVolume[0]?.Name).toBe(volume);

          const createdContainer = yield* Effect.acquireRelease(
            Docker.containerCreate({
              args: ["alpine:3.22"],
              flags: {
                name: container,
                network,
                mount: [`type=volume,src=${volume},dst=/scratch`],
              },
            }),
            () =>
              Docker.containerRm({ args: [container], flags: { force: true } }).pipe(Effect.ignore),
          );
          expect(createdContainer.stdout.trim().length).toBeGreaterThan(0);
          const inspectedContainer = yield* Docker.containerInspect({ args: [container] });
          expect(inspectedContainer[0]?.Id).toBe(createdContainer.stdout.trim());

          const inspectedImage = yield* Docker.imageInspect({ args: ["alpine:3.22"] });
          expect(inspectedImage.length).toBe(1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
