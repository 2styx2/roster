// A call the app stopped waiting for. roster serve holds its long methods to a deadline shorter than
// the app's wait (roster-core's CALL_SECS), so this should be rare; when it happens, serve may still be
// finishing the call. serve answers several requests at once (API 20), so the check waits for it: a
// write holds roster.yml for its whole request, `changes.diff` takes roster.yml too, and `host.get`
// with `settled` waits for it (an older serve answers in order, which waits anyway). These wrappers ask, and report what actually happened:
// never "it failed" for something that was done, never silence.
import { BackendCallError, type AddHostParams, type Backend, type HostAdd, type PublishResult } from "./types";

const LATE = "roster answered late, so the app checked afterwards";

export function timedOut(e: unknown): boolean {
  return e instanceof BackendCallError && e.timedOut;
}

/** `host.add`, and after a timeout: is the Host in the Inventory now? (host.add refuses a name that's
 * already there, so if it is, this add made it.) */
export async function addHostChecked(backend: Backend, params: AddHostParams): Promise<HostAdd> {
  try {
    return await backend.addHost(params);
  } catch (e) {
    if (!timedOut(e)) throw e;
    let host;
    try {
      host = await backend.getHost(params.name, { settled: true });
    } catch (check) {
      if (check instanceof BackendCallError && check.code === 2) {
        throw new BackendCallError(
          `roster didn't answer in time; checked afterwards: ${params.name} isn't in the Inventory, so it wasn't added (roster takes back a vault item it made for it)`,
          3,
          { fix: "add it again" },
        );
      }
      throw new BackendCallError(
        `roster didn't answer in time, and the app couldn't check whether ${params.name} was added`,
        3,
        { fix: `look for ${params.name} in the Sidebar and in :changes before adding it again` },
      );
    }
    const item = params.password !== undefined && params.item ? { provider: params.provider ?? "bw", id: "", name: params.item } : null;
    return { added: true, host, backup: "", verify: null, item, warnings: [`${LATE}: it's in the Inventory`] };
  }
}

/** `changes.publish`, and after a timeout: are the Pending changes gone, with the last commit on the
 * upstream? (A push that didn't land is always undone, so the changes would still be pending.) */
export async function publishChecked(backend: Backend, message: string): Promise<PublishResult> {
  try {
    return await backend.publishChanges(message);
  } catch (e) {
    if (!timedOut(e)) throw e;
    let now;
    try {
      now = await backend.pendingChanges();
    } catch {
      now = null;
    }
    const last = now?.last_commit;
    if (now && now.count > 0) {
      throw new BackendCallError(
        `roster didn't answer in time; checked afterwards: the Pending changes are still here, so nothing was published`,
        96,
        { fix: ":publish again (it fetches first)" },
      );
    }
    if (now && last?.pushed && last.upstream) {
      return {
        commit: last.commit,
        upstream: last.upstream,
        message: last.subject,
        hosts: [],
        groups: [],
        pulled: 0,
        sync: { ok: false, error: `${LATE}: it's published, but not whether this Box's ssh config followed`, fix: "run `roster sync` on this box" },
      };
    }
    throw new BackendCallError(
      "roster didn't answer in time, and the app couldn't check whether it was published",
      3,
      { fix: "open :changes: no Pending changes and the commit on the upstream means it was" },
    );
  }
}
