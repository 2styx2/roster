// `:vault signout`'s question (ticket 42), naming the account and its server.
import type { VaultAccount } from "../backend/types";
import { ConfirmPanel } from "../inventory/ConfirmPanel";
import type { PanelState } from "../panel/stack";
import { serverName, SIGN_OUT_WHAT, signOutQuestion } from "./LockScreen";

export function SignOutPanel({ asking, signOut }: { asking: PanelState<VaultAccount>; signOut(account: VaultAccount): Promise<void> }) {
  const account = asking.value;
  if (!account) return null;
  return (
    <ConfirmPanel
      title={signOutQuestion(account)}
      body={
        <>
          {SIGN_OUT_WHAT} Server: <span className="mono">{serverName(account.server)}</span>. The app locks and shows the sign-in form; open Sessions keep
          running behind it.
        </>
      }
      action="Sign out"
      onConfirm={async () => {
        asking.set(null);
        await signOut(account);
      }}
      onClose={asking.close}
    />
  );
}
