// For tests: the core's defaults fixture (the Config in config/defaults.ts, and the token names
// beside it), so the Rust and TypeScript defaults can't drift apart.
import defaults from "../../../crates/roster-core/tests/fixtures/config-defaults.json";
import { defaultConfig } from "./defaults";
import type { Config } from "./types";

export { defaultConfig };

export const configFixture: { config: Config; themeColors: string[]; themeTerminal: string[]; ansi: string[] } = {
  ...defaults,
  config: defaultConfig,
};

/** The defaults with `patch` over them, as the core would send it. */
export function configWith(patch: Partial<Config>): Config {
  return { ...structuredClone(defaultConfig), ...patch };
}
