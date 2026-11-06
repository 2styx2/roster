// Each number option's bounds, both included, by its path: the core's shape table declares them
// once (crates/roster-core/src/config/shape, `ranges` in the generated config-options.json), so a
// check of the app's own (`:panel width`, the terminal's zoom) holds to the same numbers as init.lua.
import data from "../../../crates/roster-core/tests/fixtures/config-options.json";

export const optionRanges: Readonly<Record<keyof typeof data.ranges, { min: number; max: number }>> = data.ranges;
