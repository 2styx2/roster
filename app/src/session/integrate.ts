// What `:integrate` says (ticket 121), for each way sending the shell hook line can go.
import type { IntegrateResult } from "./shellHooks";

export const INTEGRATE_SAYS: Record<IntegrateResult, (label: string) => string> = {
  on: (t) => `Shell integration is on in ${t}: its prompts are marked.`,
  "on-kept": (t) =>
    `Shell integration is on in ${t}: its prompts are marked. You'd typed in it already, so if it's zsh the hook line stays in its history (:help shell-hooks).`,
  "no-marks": (t) =>
    `Sent ${t}'s shell the hook line, but no marked prompt came back: its shell or prompt framework doesn't take it (:help shell-hooks).`,
  marked: (t) => `${t}'s shell marks its prompts already: nothing to send.`,
  "no-prompt": (t) => `${t} isn't at an empty prompt roster knows (bash, zsh, fish, PowerShell): nothing sent.`,
  "not-open": (t) => `${t}'s Session isn't open: nothing sent.`,
};
