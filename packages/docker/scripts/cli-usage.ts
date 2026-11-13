/**
 * Docker's command-reference usage is a small positional grammar, not a
 * complete flag schema. Infer only the *minimum* positional arity: optional
 * bracket groups do not count, while alternatives joined by `|` count once.
 * The CLI remains authoritative for complex cross-argument constraints.
 */
const lineArity = (suffix: string, usage: string): number => {
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
    if (bracketDepth < 0) throw new Error(`Unbalanced Docker CLI usage: ${usage}`);
    if (/\s/.test(char) && bracketDepth === 0) {
      if (token !== "") tokens.push(token);
      token = "";
    } else {
      token += char;
    }
  }
  if (bracketDepth !== 0) throw new Error(`Unbalanced Docker CLI usage: ${usage}`);
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
};

export const minimumArgs = (usage: string, command: string): number => {
  // Some official usages give multiple command forms on separate lines, e.g.
  // both directions of `docker cp`. Never add the positional arities of
  // alternatives or mistake a documented alias for positional input.
  const forms = usage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line === command || line.startsWith(command + " "));
  if (forms.length === 0) {
    throw new Error(`Unexpected Docker CLI usage: ${usage} (command ${command})`);
  }
  return Math.min(...forms.map((line) => lineArity(line.slice(command.length).trim(), usage)));
};
