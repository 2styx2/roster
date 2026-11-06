import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBackend } from "./backend";
import { fixtureProps } from "./backend/fixtureProps";
import { createPlatform } from "./platform";
import type { ConfigReport } from "./config/types";
import { defaultAppearance } from "./theme/theme";
// The fonts ship in the bundle (the CSP allows no network fonts): Inter for the UI, Iosevka for
// the terminal and the wordmark (decision Q30). The terminal is medium (500) by default, with
// 700 for bold; 400 stays for init.lua's `terminal.weight = 400`.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/iosevka/400.css";
import "@fontsource/iosevka/500.css";
import "@fontsource/iosevka/700.css";
import { terminalFontStack } from "./terminal/fonts";
import { defaultTerminalOptions } from "./terminal/options";
import "./styles.css";

/** The terminal measures its cells when it opens, so its font must be loaded by then (the
 * Config's, if it names one). Local files load in a few milliseconds; the timeout only guards
 * against a font that never comes. */
function fontsLoaded(report: ConfigReport | null): Promise<unknown> {
  const t = report?.config.terminal;
  // The whole list: what's installed is there already; the bundled Iosevka loads if it's in it.
  const family = terminalFontStack(t?.font ?? defaultTerminalOptions.fonts);
  const fonts = [
    `${t?.weight ?? 500} 14px ${family}`,
    `${t?.boldWeight ?? 700} 14px ${family}`,
    '400 13px "Inter"',
    '500 13px "Inter"',
  ];
  const loaded = Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {});
  return Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

// In a plain browser (no Config): `?theme=nord` picks a Theme, for trying them.
const appearance = { ...defaultAppearance, theme: new URLSearchParams(location.search).get("theme") ?? defaultAppearance.theme };

// The "Demo data / Worst case" toggle (ticket 27): dev builds only, and only when asked for -
// a `?fixture=` page or VITE_ROSTER_APP_FIXTURES=1 (the old VITE_ROSTER_DESK_FIXTURES=1 still
// works) - so running the real app from `tauri dev`
// shows no test controls. `import.meta.env.DEV` is false in a production build, so the import
// below and its chunk are dropped from it.
const wantFixtures =
  new URLSearchParams(location.search).has("fixture") ||
  import.meta.env.VITE_ROSTER_APP_FIXTURES === "1" ||
  import.meta.env.VITE_ROSTER_DESK_FIXTURES === "1";
const FixtureToggle = import.meta.env.DEV && wantFixtures ? lazy(() => import("./dev/FixtureToggle")) : null;

const root = createRoot(document.getElementById("root") as HTMLElement);
void Promise.all([createBackend(), createPlatform()]).then(async ([{ backend, app }, platform]) => {
  // The Config (init.lua, ticket 21) before the first paint, so its Theme and keys are there
  // from the start.
  // One that can't be read starts the app with the defaults; useConfigReport asks again once it's up.
  const config = (await platform.config?.load().catch(() => null)) ?? null;
  await fontsLoaded(config);
  root.render(
    <StrictMode>
      <App backend={backend} appearance={appearance} config={config} {...fixtureProps(app, platform)} />
      {FixtureToggle && (
        <Suspense>
          <FixtureToggle />
        </Suspense>
      )}
    </StrictMode>,
  );
});
