/**
 * Docker's command-reference usage is a small positional grammar, not a
 * complete flag schema. Infer only the *minimum* positional arity: optional
 * bracket groups do not count, while alternatives joined by `|` count once.
 * The CLI remains authoritative for complex cross-argument constraints.
 */
import * as A from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export class DockerCliUsageError extends Schema.TaggedError<DockerCliUsageError>()(
  "DockerCliUsageError",
  { usage: Schema.String, reason: Schema.Literals(["unbalanced-brackets", "unknown-command"]) },
) {}

const lineArity = (suffix: string, usage: string) =>
  Effect.gen(function* () {
    if (suffix === "") return 0;
    let required = 0;
    let bracketDepth = 0;
    let token = "";
    const tokens: string[] = [];
    // Whitespace outside [] separates expressions. A token such as
    // NAME[:TAG|@DIGEST] is one required argument, not three.
    for (const char of suffix) {
      if (char === "[") bracketDepth++;
      if (char === "]") bracketDepth--;
      if (bracketDepth < 0) {
        return yield* new DockerCliUsageError({ usage, reason: "unbalanced-brackets" });
      }
      if (/\s/.test(char) && bracketDepth === 0) {
        if (token !== "") tokens.push(token);
        token = "";
      } else {
        token += char;
      }
    }
    if (bracketDepth !== 0) {
      return yield* new DockerCliUsageError({ usage, reason: "unbalanced-brackets" });
    }
    if (token !== "") tokens.push(token);

    for (const [index, current] of tokens.entries()) {
      if (
        current === "|" ||
        tokens[index - 1] === "|" ||
        current.startsWith("[") ||
        current === "OPTIONS" ||
        current === "--" ||
        current.startsWith("--")
      )
        continue;
      required++;
    }
    return required;
  });

export const minimumArgs = (usage: string, command: string) =>
  Effect.gen(function* () {
    // Some official usages give multiple command forms on separate lines, e.g.
    // both directions of `docker cp`. Never add the positional arities of
    // alternatives or mistake a documented alias for positional input.
    const forms = A.filter(
      A.map(Str.split(usage, /\r?\n/), Str.trim),
      (line) => line === command || line.startsWith(command + " "),
    );
    if (A.isArrayEmpty(forms)) {
      return yield* new DockerCliUsageError({ usage, reason: "unknown-command" });
    }
    const arities = yield* Effect.forEach(forms, (line) =>
      lineArity(Str.trim(line.slice(command.length)), usage),
    );
    if (!A.isArrayNonEmpty(arities)) {
      return yield* new DockerCliUsageError({ usage, reason: "unknown-command" });
    }
    return A.min(arities, Order.Number);
  });
