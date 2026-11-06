// The fake Backend cuts `cmd:`/`env:` Login references from what a Plugin gets, as the core does
// (decision Q92), on the cases the core and the CLI are tested on: tests/vectors/redaction.json.
import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/redaction.json";
import { pluginServeError, redact, redactText } from "./redact";

/** An error case, written as the CLI's text (`MESSAGE (code N)`), as serve's error reaches a
 * Plugin: the message cut, the code its own field, then the text again (the core's served_error). */
const servedError = (input: string): string => {
  const m = / \(code (-?[0-9]+)\)$/.exec(input);
  const e = m ? Object.assign(new Error(input.slice(0, m.index)), { code: Number(m[1]) }) : new Error(input);
  return String(pluginServeError("X", e)).slice("X: ".length);
};

describe("the cmd:/env: cut (Q92), as the core's", () => {
  it.each(vectors.cases.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    expect(("error" in c && c.error ? servedError : redactText)(c.in)).toBe(c.out);
  });

  it.each(vectors.values.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    expect(redact(c.in)).toEqual(c.out);
  });
});
