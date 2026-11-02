// A performance budget times the machine as much as the code: on a busy machine (a full
// `npm run check`, CI next to other jobs) the 16 ms frame and the 150 ms layout failed most
// runs however fast the code was (T146). So each budget is a test of its own that runs only on
// request, on an idle machine: `ROSTER_PERF=1 npm test`. What the code does (no overlaps, every
// title placed) stays in the ordinary tests, which always run.
import { it } from "vitest";

/** `it` for a performance budget: runs only with ROSTER_PERF set. */
export const budget = it.runIf(Boolean(process.env["ROSTER_PERF"]));
