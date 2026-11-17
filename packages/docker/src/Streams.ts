/**
 * Raw, incremental response bodies for Docker Engine operations that stream
 * JSON lines, archives, logs, or multiplexed stdout/stderr frames.
 *
 * Reuse the generated operation's request schema and DockerProtocol encoder;
 * do not reimplement endpoint routes, registry authentication or versioning.
 * The generated, decoded operations remain the preferred API for normal JSON.
 *
 * Unlike a generated operation's decoded response, the returned bytes are
 * deliberately not parsed or buffered in memory. Docker's attach/exec HTTP
 * connection upgrades require a separate bidirectional transport.
 */
import type * as API from "@distilled.cloud/core/api";
import * as Api from "@distilled.cloud/core/api";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * Run a generated Engine request while consuming its body as raw bytes.
 *
 * The HTTP transport, authorization, request encoding and endpoint are those
 * of the supplied Engine Layer. Non-2xx responses fail with the Effect HTTP
 * status error; Docker-specific error decoding is only available when using
 * the generated operation normally.
 *
 * @example
 * import * as Docker from "@distilled.cloud/docker";
 * import * as DockerStreams from "@distilled.cloud/docker/Streams";
 *
 * const bytes = DockerStreams.response(Docker.containerLogs, {
 *   id: "web", stdout: true, stderr: true, follow: true,
 * });
 */
export const response = <I, O, E, R>(operation: API.OperationMethod<I, O, E, R>, input: I) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const protocol = yield* Api.Protocol;
        const client = yield* HttpClient.HttpClient;
        const request = yield* protocol.encode({
          input,
          inputAst: operation.input.ast,
          config: { input: operation.input, output: operation.output },
        });
        const result = yield* client.execute(request);
        const checked = yield* HttpClientResponse.filterStatusOk(result);
        return checked.stream;
      }),
    ),
  );

/** A Docker non-TTY multiplexed stream frame, with its binary body intact. */
export interface Frame {
  readonly channel: "stdin" | "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

export class DockerFrameError extends Data.TaggedError("DockerFrameError")<{
  readonly reason: "InvalidHeader" | "FrameTooLarge" | "TruncatedFrame";
}> {}

// Docker frames are normally small. Cap one frame to avoid retaining an
// arbitrary amount of untrusted daemon/proxy output while waiting for bytes.
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

/**
 * Split Docker's non-TTY stdcopy frames into stdin/stdout/stderr binary events.
 * Headers and payloads may arrive across any number of HTTP chunks. Invalid
 * headers, oversized frames and incomplete final frames fail explicitly.
 *
 * Do not use this for containers with TTY enabled: their logs are raw bytes.
 * The function does not perform HTTP upgrades or bidirectional attach.
 */
export const demultiplex = <E, R>(source: Stream.Stream<Uint8Array, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pending = yield* Ref.make(new Uint8Array(0));
      const decoded = source.pipe(
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            const previous = yield* Ref.get(pending);
            const bytes = new Uint8Array(previous.length + chunk.length);
            bytes.set(previous);
            bytes.set(chunk, previous.length);
            const frames: Array<Frame> = [];
            let offset = 0;
            while (bytes.length - offset >= 8) {
              const type = bytes[offset]!;
              if (
                type > 2 ||
                bytes[offset + 1] !== 0 ||
                bytes[offset + 2] !== 0 ||
                bytes[offset + 3] !== 0
              ) {
                return yield* Effect.fail(new DockerFrameError({ reason: "InvalidHeader" }));
              }
              const size =
                bytes[offset + 4]! * 0x1000000 +
                bytes[offset + 5]! * 0x10000 +
                bytes[offset + 6]! * 0x100 +
                bytes[offset + 7]!;
              if (size > MAX_FRAME_SIZE) {
                return yield* Effect.fail(new DockerFrameError({ reason: "FrameTooLarge" }));
              }
              if (bytes.length - offset < 8 + size) break;
              frames.push({
                channel: type === 0 ? "stdin" : type === 1 ? "stdout" : "stderr",
                bytes: bytes.slice(offset + 8, offset + 8 + size),
              });
              offset += 8 + size;
            }
            yield* Ref.set(pending, bytes.slice(offset));
            return frames;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );
      const checkComplete = Stream.fromEffectDrain(
        Ref.get(pending).pipe(
          Effect.flatMap((bytes) =>
            bytes.length === 0
              ? Effect.void
              : Effect.fail(new DockerFrameError({ reason: "TruncatedFrame" })),
          ),
        ),
      );
      return Stream.concat(decoded, checkComplete);
    }),
  );
