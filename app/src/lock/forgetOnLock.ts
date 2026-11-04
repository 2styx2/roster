// Typed passwords not sent yet are emptied when the app locks. The workspace stays mounted behind
// the lock screen (inert, so its Sessions keep running), so a password typed into the add-Host
// form or a connect card and left there would otherwise still be in its input after the next
// unlock. Each such input registers how to empty itself; App calls forgetTypedOnLock() whenever
// the vault locks (docs/app/security.md, "Locking").

import { useEffect } from "react";

const forgetters = new Set<() => void>();

/** Empty every typed password registered with useForgetOnLock. */
export function forgetTypedOnLock(): void {
  for (const forget of forgetters) forget();
}

/** Run `forget` (which empties this component's password input) whenever the app locks. */
export function useForgetOnLock(forget: () => void): void {
  useEffect(() => {
    forgetters.add(forget);
    return () => {
      forgetters.delete(forget);
    };
  }, [forget]);
}
