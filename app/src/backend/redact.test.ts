// The fake Backend cuts `cmd:`/`env:` Login references from what a Plugin gets, as the core does
// (decision Q92), on the cases the core and the CLI are tested on: tests/vectors/redaction.json.
import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/redaction.json";
import { redact, redactError, redactText } from "./redact";

describe("the cmd:/env: cut (Q92), as the core's", () => {
  it.each(vectors.cases.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    expect(("error" in c && c.error ? redactError : redactText)(c.in)).toBe(c.out);
  });

  it.each(vectors.values.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    expect(redact(c.in)).toEqual(c.out);
  });
});
