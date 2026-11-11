// Reading the environment variables of the server, as pure functions so the rules can
// be tested without starting it.

// The value, or the default when the variable is unset OR empty. `??` alone is not
// enough: `HOST=` (set but empty) would reach listen() as "", which binds every network
// interface, and `PORT=` would become port 0, which means "any free port".
export function valueOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

// A TCP port as a number, or undefined when the text is not a whole number from 1 to
// 65535. Digits only, so "3000abc", "1e3", "-1" and "30.5" are refused instead of being
// read as some port the operator did not mean.
export function parsePort(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}
