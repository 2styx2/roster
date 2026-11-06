// The built-ins that act on the workspace's own objects (commands/builtins.ts), registered for as
// long as the workspace lives; what they open is the workspace's as of its last render.
import { useEffect, useLayoutEffect, useState } from "react";
import { registerBuiltins, type BuiltinDeps } from "../commands/builtins";
import type { PluginManager } from "../plugins/manager";
import type { Registries } from "../registries";
import type { TutorialDef } from "../tutor/tutor";
import type { TutorLink } from "../tutor/useDemo";
import { Latest } from "../ui/latest";

export interface Openers {
  plugins(): void;
  packages(): void;
  /** A tutorial's page, where you left off. */
  tutorial(def: TutorialDef): void;
}

const none: Openers = { plugins: () => {}, packages: () => {}, tutorial: () => {} };

export function useBuiltins(
  registries: Registries,
  deps: Omit<BuiltinDeps, "plugins" | "tutor"> & { plugins: PluginManager },
  tutor: TutorLink | undefined,
  openers: Openers,
) {
  const [open] = useState(() => new Latest(none));
  useLayoutEffect(() => open.set(openers));
  const { help, theme, hints, messages, views, panels, plugins } = deps;
  useEffect(
    () =>
      registerBuiltins(registries, {
        help,
        theme,
        hints,
        messages,
        views,
        panels,
        plugins: { manager: plugins, openPlugins: () => open.get().plugins(), openPackages: () => open.get().packages() },
        // `:tutor` (ticket 55): starts a tutorial on the demo Inventory, or, on it, opens the page again.
        tutor: tutor
          ? {
              start: (def) =>
                tutor.demo
                  ? def.id === tutor.demo.tutorial.id
                    ? open.get().tutorial(def)
                    : tutor.demo.switchTo(def)
                  : tutor.start?.(def, plugins.forDemo()),
              quit: () => {
                if (!tutor.demo) return false;
                tutor.demo.leave();
                return true;
              },
              reset: (def) => {
                tutor.progress.reset(def.id);
                if (tutor.demo?.tutorial.id === def.id) open.get().tutorial(def);
              },
            }
          : null,
      }),
    [registries, help, theme, hints, messages, views, panels, plugins, tutor, open],
  );
  return open;
}
