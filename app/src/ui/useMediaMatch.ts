import { useSyncExternalStore } from "react";

/** Whether a media query matches now, following it as the window changes. */
export function useMediaMatch(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const mq =
        typeof window !== "undefined" && window.matchMedia
          ? window.matchMedia(query)
          : null;
      mq?.addEventListener("change", changed);
      return () => mq?.removeEventListener("change", changed);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : false,
  );
}
