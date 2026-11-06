// Typed passwords not sent yet are emptied when the workspace locks. The workspace stays mounted
// behind the lock screen (inert, so its Sessions keep running), so a password typed into the
// add-Host form or a connect card and left there would otherwise still be in its input after the
// next unlock (docs/app/security.md, "Locking"). Each workspace has its own: the tutor's demo
// locking never empties what you typed in yours.
import { createContext, useContext, useEffect } from "react";

export class TypedPasswords {
  private readonly forgetters = new Set<() => void>();

  /** Empties every typed password registered here. */
  forget(): void {
    for (const forget of this.forgetters) forget();
  }

  add(forget: () => void): () => void {
    this.forgetters.add(forget);
    return () => void this.forgetters.delete(forget);
  }
}

/** The workspace's; outside one (a component's own test), nothing is ever emptied. */
export const TypedPasswordsContext = createContext<TypedPasswords | null>(null);

/** Runs `forget` (which empties this component's password input) whenever its workspace locks. */
export function useForgetOnLock(forget: () => void): void {
  const typed = useContext(TypedPasswordsContext);
  useEffect(() => typed?.add(forget), [typed, forget]);
}
