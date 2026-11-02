// The Plugin pieces the core draws (ticket 23, decision Q81): the permission prompt, `:plugins`,
// a Plugin's floating window and its notices. A Plugin only ever hands over text; these draw it
// with roster's own tokens and keycaps, so a Plugin looks native and can't draw anything else.
// They open from a key or a command, so none of them animates (taste.md: motion confirms; a key
// confirms itself), like the other side panels.
import { useEffect, useRef, useState } from "react";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";
import type { PackageStatus, PackageUpdate, PluginData, SiteRequests } from "../backend/types";
import { kindOf, SIGN_WORD } from "../edit/ChangesPanel";
import { PACKAGE_PREFIX, type Notice, type PendingConfirm, type PluginStatus, type Prompt, type RunningProgress, type Snapshot } from "./manager";

/** Install or update: who it's from, every permission with the risky ones flagged and explained.
 * A Package's shows its git URL as the source, and its update the new commit and its diff. */
/** It opens with the keys on the safe choice (Cancel, Keep, Not now), never on Install: a prompt can
 * come up while you're typing elsewhere (behind the lock screen, after a command line), and a stray
 * Enter mustn't run code you haven't read about. Install is a deliberate move (Shift+Tab, or a
 * click), and a held-down Enter answers nothing (decision Q87). `safe` is that button, for the
 * workspace to give the keys back to. */
export function PluginPrompt({ prompt, onAnswer, safe }: { prompt: Prompt; onAnswer(allow: boolean): void; safe?: (button: HTMLButtonElement | null) => void }) {
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => no.current?.focus(), []);
  const m = prompt.manifest;
  const install = prompt.kind === "install";
  const pkg = prompt.package;
  const update = pkg?.update;
  const asked = m.permissions.filter((p) => prompt.asking.includes(p.name));
  const title = install ? `Install ${m.name}?` : update ? `Update ${m.name}?` : `${m.name} asks for more`;
  const action = install ? "Install" : update ? "Update" : "Allow";
  const noLabel = install ? "Cancel" : update ? `Keep ${short(update.from)}` : "Not now";
  const noHint = install ? "cancel" : update ? "keep the version it has" : "run without them";
  return (
    <section
      tabIndex={-1}
      className="side-panel plugin-prompt"
      role="alertdialog"
      aria-label={title}
      onKeyDown={(e) => {
        // A key held down from before the prompt (the Enter that unlocked, say) answers nothing.
        if (e.key === "Enter" && e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onAnswer(false);
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" className="icon-button close" aria-label={noLabel} onClick={() => onAnswer(false)}>
          <CloseGlyph />
        </button>
      </header>
      <p className="plugin-about">
        {m.description || "No description."} <span className="mono">{m.version}</span>
        {m.author ? <> by {m.author}</> : null}
      </p>
      <p className="plugin-source muted">
        Unverified: from <span className="mono">{pkg ? pkg.url : prompt.path}</span>
        {pkg?.dir ? (
          <>
            , folder <span className="mono">{pkg.dir}</span>
            {pkg.commit && !update ? "," : ""}
          </>
        ) : null}
        {pkg?.commit && !update ? (
          <>
            {" "}
            at <span className="mono">{short(pkg.commit)}</span>
          </>
        ) : null}
        . A Plugin is code; install only what you trust.
      </p>
      {update && <PackageChange update={update} />}
      {asked.length === 0 ? (
        <p>
          {update
            ? "It asks for no new permissions."
            : "It asks for no permissions: it can add commands, keys and its own UI, and nothing else."}
        </p>
      ) : (
        <>
          <p>{install ? "It asks to:" : "Its new version also asks to:"}</p>
          <ul className="plugin-permissions">
            {asked.map((p) => (
              <li key={p.name} className={p.risk ? "risky" : undefined}>
                <span className="mono">{p.name}</span> {p.summary}
                {p.risk && <span className="plugin-risk">{p.risk}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">It never sees a password, the vault or what you type at a login prompt, and it can&rsquo;t Publish.</p>
      <div className="edit-actions">
        <button type="button" onClick={() => onAnswer(true)}>
          {action}
        </button>
        <button
          ref={(el) => {
            no.current = el;
            safe?.(el);
          }}
          type="button"
          onClick={() => onAnswer(false)}
        >
          {noLabel}
        </button>
        <span className="edit-keys muted key-hint">
          <Keys keys="Shift+Tab Enter" /> {action.toLowerCase()} <Keys keys="Escape" /> {noHint}
        </span>
      </div>
    </section>
  );
}

const short = (commit: string | null) => (commit ?? "").slice(0, 7);

/** What a Package's update changes: the commits, then the diff (data, so Iosevka; tinted lines). */
function PackageChange({ update }: { update: PackageUpdate }) {
  const lines = update.diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <>
      <p>
        <span className="mono">{short(update.from)}</span> to <span className="mono">{short(update.to)}</span>
        {update.log.length > 0 && <>, {update.log.length === 1 ? "1 commit" : `${update.log.length} commits`}:</>}
      </p>
      {update.log.length > 0 && (
        <ul className="package-log mono">
          {update.log.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <pre className="diff package-diff" aria-label={`What changes from ${short(update.from)} to ${short(update.to)}`}>
        {lines.map((line, i) => {
          const kind = kindOf(line);
          return (
            <span key={i} className={`diff-line ${kind}`}>
              {(kind === "add" || kind === "del") && <span className="visually-hidden">{SIGN_WORD[kind]}</span>}
              {line || " "}
              {"\n"}
            </span>
          );
        })}
      </pre>
      {update.truncated && <p className="muted">The diff is cut short here; the rest is in the repo.</p>}
    </>
  );
}

const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/** What `:plugins` says under a granted site (decision Q116): counts and a time, never what went. */
export function requestsLine(r: SiteRequests | undefined, now: number): string {
  if (!r || r.requests === 0) return "No requests since roster started";
  const n = (x: number) => x.toLocaleString("en-US");
  const failed = r.failed > 0 ? `, ${n(r.failed)} with no answer` : "";
  return `${n(r.requests)} ${r.requests === 1 ? "request" : "requests"}${failed}, the last ${ago(r.last, now)}`;
}

const MB = 1024 * 1024;

/** A data folder's size: bytes, KB or MB (1,024s, as the 10 MB cap counts). */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const kb = Math.round(bytes / 1024);
  return kb < 1024 ? `${kb.toLocaleString("en-US")} KB` : `${(bytes / MB).toFixed(1)} MB`;
}

/** What `:plugins` says about a Plugin's data folder (ticket 98): how full it is against both
 * caps (decision Q93), counted when the panel opened. */
export function dataLine(d: PluginData): string {
  if (d.state === "problem") return `Data: can't count it: ${d.message}`;
  if (d.state === "none" || d.files === 0) return "Data: none yet";
  const files = `${d.files.toLocaleString("en-US")} ${d.files === 1 ? "file" : "files"}`;
  return `Data: ${size(d.bytes)} in ${files} (of 10 MB, 1,000 files)`;
}

function PluginRow({ p, onGrant, now }: { p: PluginStatus; onGrant(name: string, permission: string, on: boolean): void; now: number }) {
  const state = p.waiting ? "waiting for you" : p.problem ? "stopped" : "running";
  // A line each about the Plugin as a whole, under its permissions.
  const facts: string[] = [];
  if (p.data) facts.push(dataLine(p.data));
  if (p.uses.length > 0) facts.push(`Recently: ${p.uses.slice(0, 3).map((u) => `${u.what} ${ago(u.at, now)}`).join(", ")}`);
  return (
    <li className="plugin-row" aria-label={`${p.name}, ${state}`}>
      <div className="plugin-head">
        <span className="plugin-name mono">{p.name}</span>
        {p.manifest && <span className="mono muted">{p.manifest.version}</span>}
        <span className={`plugin-state${p.problem ? " problem" : ""}`}>{state}</span>
      </div>
      <div className="plugin-source muted mono">
        {p.builtin ? "built into roster" : p.path.startsWith(PACKAGE_PREFIX) ? `Package ${p.path.slice(PACKAGE_PREFIX.length)}` : p.path}
      </div>
      {p.problem && <div className="plugin-problem">{p.problem}</div>}
      {p.manifest && p.manifest.permissions.length > 0 ? (
        <ul className="plugin-permissions">
          {p.manifest.permissions.map((perm) => {
            const on = p.granted.includes(perm.name);
            return (
              <li key={perm.name} className={perm.risk ? "risky" : undefined}>
                <label>
                  <input type="checkbox" role="switch" checked={on} onChange={() => onGrant(p.name, perm.name, !on)} />{" "}
                  <span className="mono">{perm.name}</span> {perm.summary}
                </label>
                {on && perm.name.startsWith("network:") && (
                  <div className="plugin-requests muted">{requestsLine(p.requests.find((r) => `network:${r.site}` === perm.name), now)}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        p.manifest && <div className="muted">No permissions.</div>
      )}
      {facts.map((f) => (
        <div key={f} className="plugin-uses muted">
          {f}
        </div>
      ))}
    </li>
  );
}

/** How often `:plugins` asks the core for its request counts while it's open. */
export const REFRESH_MS = 3000;

/** `:plugins`: every Plugin, whether it runs, its grants as toggles, and what it did lately. */
export function PluginsPanel({
  snapshot,
  onGrant,
  onClose,
  onRefresh,
  onOpen,
}: {
  snapshot: Snapshot;
  onGrant(name: string, permission: string, on: boolean): void;
  onClose(): void;
  /** Asks the core for each site's request counts (decision Q116): when it opens, then every
   * REFRESH_MS while it's open. */
  onRefresh?(): void;
  /** Asks the core how full each Plugin's data folder is (ticket 98): once, when it opens. */
  onOpen?(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  // "2m ago" is counted from the last refresh; the text just changes, nothing moves.
  const [now, setNow] = useState(() => Date.now());
  const refresh = useRef(onRefresh);
  const opened = useRef(onOpen);
  useEffect(() => opened.current?.(), []);
  useEffect(() => {
    refresh.current = onRefresh;
  });
  useEffect(() => {
    refresh.current?.();
    const timer = setInterval(() => {
      refresh.current?.();
      setNow(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="side-panel plugins-panel"
      aria-label="Plugins"
      onKeyDown={(e) => {
        // A key held down from before the prompt (the Enter that unlocked, say) answers nothing.
        if (e.key === "Enter" && e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header>
        <h2>Plugins</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      {snapshot.plugins.length === 0 ? (
        <p className="panel-empty">
          No Plugins. <code>:plugins install PATH</code> installs one from a folder.
        </p>
      ) : (
        <ul className="plugin-list">
          {snapshot.plugins.map((p) => (
            <PluginRow key={p.name} p={p} onGrant={onGrant} now={now} />
          ))}
        </ul>
      )}
      <p className="panel-foot muted">
        A switch off takes that permission away at once. <code>:plugins remove NAME</code> uninstalls; <code>:help plugins</code> says more.
      </p>
    </section>
  );
}

/** A Plugin's floating window over the terminal: a title, lines of text, and its buttons and links
 * at the foot (ticket 78). Esc (or `q`) closes it; an action's key runs it while it has focus. A
 * link shows its host, so where it goes is seen before the click. */
export function PluginFloatPanel({
  float,
  onClose,
  onAction,
  onLink,
}: {
  float: NonNullable<Snapshot["float"]>;
  onClose(): void;
  onAction?(index: number): void;
  onLink?(index: number): void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  const actions = float.actions;
  const links = float.links;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="side-panel plugin-float"
      aria-label={`${float.title || float.plugin} (from ${float.plugin})`}
      onKeyDown={(e) => {
        // A key held down from before the prompt (the Enter that unlocked, say) answers nothing.
        if (e.key === "Enter" && e.repeat) {
          e.preventDefault();
          return;
        }
        const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
        if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
          const i = actions.findIndex((a) => a.key === e.key);
          if (i >= 0) {
            e.preventDefault();
            e.stopPropagation();
            return onAction?.(i);
          }
        }
        if (e.key !== "Escape" && !(e.key === "q" && !typing)) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header>
        <h2>{float.title || float.plugin}</h2>
        <button type="button" className="icon-button close" aria-label="Close" onClick={onClose}>
          <CloseGlyph />
        </button>
      </header>
      <pre className="plugin-float-lines">{float.lines.join("\n")}</pre>
      {(actions.length > 0 || links.length > 0) && (
        <div className="plugin-float-foot">
          {actions.map((a, i) => (
            <button key={`a${i}`} type="button" className="plugin-float-action" onClick={() => onAction?.(i)} title={a.key ? `${a.label} (${a.key})` : a.label}>
              {a.label}
              {a.key && <Keys keys={a.key} />}
            </button>
          ))}
          {links.map((l, i) => (
            <a
              key={`l${i}`}
              className="plugin-float-link"
              href={l.url}
              title={l.url}
              onClick={(e) => {
                e.preventDefault();
                onLink?.(i);
              }}
            >
              {l.label} <span className="mono muted">{hostOf(l.url)}</span>
              <span className="visually-hidden"> (opens in the browser)</span>
            </a>
          ))}
        </div>
      )}
      <p className="panel-foot muted">From {float.plugin}</p>
    </aside>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A Plugin's question (`roster.confirm`, ticket 78), drawn by the app with the Plugin's name on
 * it; only the user answers it. The stronger form (`danger`) puts the keys on Cancel, so a stray
 * Enter declines, and with `typed` the button works only once that word is typed. A held-down
 * Enter answers nothing. It opens from the user's own key or click, so, like the other side
 * panels, it doesn't animate. */
export function PluginConfirmPanel({ confirm, onAnswer }: { confirm: PendingConfirm; onAnswer(yes: boolean): void }) {
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const ready = confirm.typed === undefined || typed === confirm.typed;
  useEffect(() => {
    if (confirm.typed !== undefined) field.current?.focus();
    else if (confirm.danger) no.current?.focus();
    else yes.current?.focus();
  }, [confirm.typed, confirm.danger]);
  const paragraphs = confirm.text ? confirm.text.split(/\n\s*\n/).filter((p) => p.trim() !== "") : [];
  return (
    <section
      tabIndex={-1}
      className="side-panel confirm-panel plugin-confirm"
      role="alertdialog"
      aria-label={`${confirm.title} (from ${confirm.plugin})`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onAnswer(false);
      }}
    >
      <header>
        <h2>{confirm.title}</h2>
        <button type="button" className="icon-button close" aria-label="Cancel" onClick={() => onAnswer(false)}>
          <CloseGlyph />
        </button>
      </header>
      <div className="changes-confirm">
        {paragraphs.map((p, i) => (
          <p key={i} className="view-text">
            {p}
          </p>
        ))}
        {confirm.facts.length > 0 && (
          <dl className="details-facts view-facts">
            {confirm.facts.map((f, i) => (
              <div key={`${f.label}:${i}`} className="details-fact">
                <dt>{f.label}</dt>
                <dd className={f.data ? "mono" : undefined} dir="auto">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {confirm.typed !== undefined && (
          <label className="plugin-confirm-typed">
            <span>
              Type <code>{confirm.typed}</code> to {confirm.action.toLowerCase()}
            </span>
            <input
              ref={field}
              className="mono"
              spellCheck={false}
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.repeat) return;
                e.preventDefault();
                if (ready) onAnswer(true);
              }}
            />
          </label>
        )}
        <div className="edit-actions">
          <button ref={yes} type="button" className={confirm.danger ? "danger" : "primary"} disabled={!ready} onClick={() => onAnswer(true)}>
            {confirm.action}
          </button>
          <button ref={no} type="button" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <span className="edit-keys muted key-hint">
            {confirm.danger && confirm.typed === undefined ? (
              <>
                <Keys keys="Shift+Tab" /> then <Keys keys="Enter" /> {confirm.action.toLowerCase()}
              </>
            ) : (
              <>
                <Keys keys="Enter" /> {confirm.action.toLowerCase()}
              </>
            )}{" "}
            <Keys keys="Escape" /> cancel
          </span>
        </div>
      </div>
      <p className="panel-foot muted">Asked by {confirm.plugin}</p>
    </section>
  );
}

/** What Plugins are doing that takes a while (`roster.progress`, ticket 78), in the status bar: the
 * title, a hairline track (filled as far as it's done, or an edge that travels along it while it
 * only knows it's going), the share, and a button that stops it (`:cancel ID`). The latest keeps
 * its title longest: the others are `older`, and give way first when the bar is short (ticket 85). */
export function PluginProgressItems({ progress, onCancel }: { progress: readonly RunningProgress[]; onCancel(id: string): void }) {
  return (
    <>
      {progress.map((p, i) => {
        const known = p.done !== undefined && p.total !== undefined;
        const share = known ? Math.round(((p.done as number) / (p.total as number)) * 100) : null;
        const title = `${p.title}${p.text ? `: ${p.text}` : ""} (from ${p.plugin})`;
        return (
          <span key={p.id} className={`statusbar-progress${i < progress.length - 1 ? " older" : ""}`} title={title}>
            <span className="statusbar-progress-title statusbar-cut">{p.stopping ? `${p.title}: stopping…` : p.title}</span>
            <span
              className={`progress-track${known ? "" : " going"}`}
              role="progressbar"
              aria-label={p.title}
              aria-valuemin={known ? 0 : undefined}
              aria-valuemax={known ? 100 : undefined}
              aria-valuenow={share ?? undefined}
              aria-valuetext={p.stopping ? "stopping" : (share !== null ? `${share}%` : "going")}
            >
              <span className="progress-fill" style={known ? { transform: `scaleX(${(p.done as number) / (p.total as number)})` } : undefined} />
            </span>
            {share !== null && <span className="statusbar-progress-share">{share}%</span>}
            {p.cancel && !p.stopping && (
              <button type="button" className="statusbar-progress-stop" aria-label={`Stop ${p.title}`} title={`Stop (:cancel ${p.id})`} onMouseDown={(e) => e.preventDefault()} onClick={() => onCancel(p.id)}>
                <CloseGlyph />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

/** What Plugins said, and their errors (naming the Plugin, file and line). */
export function PluginNotices({ notices, onClose, onAction }: { notices: readonly Notice[]; onClose(id: number): void; onAction?(id: number, index: number): void }) {
  if (notices.length === 0) return null;
  return (
    <div className="plugin-notices">
      {notices.map((n) => (
        <div
          key={n.id}
          className={`config-toast${n.level === "error" ? " error" : ""}`}
          role={n.level === "info" ? "status" : "alert"}
          aria-label={`From ${n.plugin}`}
        >
          <div className="config-toast-head">
            <span className="config-toast-title">{n.text}</span>
            <button type="button" className="config-toast-close" aria-label="Close" onClick={() => onClose(n.id)}>
              <CloseGlyph />
            </button>
          </div>
          {n.actions && onAction && (
            <div className="notice-actions">
              {n.actions.map((a, i) => (
                <button key={a.label} type="button" onClick={() => onAction(n.id, i)}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** What a Package is doing, in a word or two. */
function packageState(p: PackageStatus, plugin: PluginStatus | undefined, declined: boolean): { text: string; problem: boolean } {
  if (p.error) return { text: "can't fetch", problem: true };
  if (!p.pinned) return { text: declined ? "cancelled" : "not installed", problem: false };
  if (!plugin) return { text: "installed", problem: false };
  if (plugin.waiting) return { text: "waiting for you", problem: false };
  if (plugin.problem) return { text: "stopped", problem: true };
  return { text: "running", problem: false };
}

/** `:packages`: what init.lua names, the commit each is at, and whether it runs. */
export function PackagesPanel({ snapshot, onClose }: { snapshot: Snapshot; onClose(): void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="side-panel plugins-panel"
      aria-label="Packages"
      onKeyDown={(e) => {
        // A key held down from before the prompt (the Enter that unlocked, say) answers nothing.
        if (e.key === "Enter" && e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header>
        <h2>Packages</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      {snapshot.packages.length === 0 ? (
        <p className="panel-empty">
          No Packages. Name one in init.lua: <code>packages = {"{"} {"{"} &quot;owner/repo&quot;, tag = &quot;v1.0.0&quot; {"}"} {"}"}</code>
        </p>
      ) : (
        <ul className="plugin-list">
          {snapshot.packages.map((p) => {
            const plugin = snapshot.plugins.find((x) => x.path === `${PACKAGE_PREFIX}${p.name}`);
            const declined = snapshot.declined.includes(p.name);
            const state = packageState(p, plugin, declined);
            return (
              <li key={p.name} className="plugin-row" aria-label={`${p.name}, ${state.text}`}>
                <div className="plugin-head">
                  <span className="plugin-name mono">{p.name}</span>
                  {p.commit && <span className="mono muted">{short(p.commit)}</span>}
                  <span className={`plugin-state${state.problem ? " problem" : ""}`}>{state.text}</span>
                </div>
                <div className="plugin-source muted mono">{p.dir ? `${p.url}, folder ${p.dir}` : p.url}</div>
                <div className="muted">{p.wants}</div>
                {p.note && <div className="muted">{p.note}</div>}
                {declined && (
                  <div className="muted">
                    You cancelled its install. <code>:packages install {p.name}</code> asks again.
                  </div>
                )}
                {(p.error ?? plugin?.problem) && <div className="plugin-problem">{p.error ?? plugin?.problem}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="panel-foot muted">
        <code>:packages update</code> shows what&rsquo;s new before applying it; <code>:packages clean</code> removes what init.lua no
        longer names. Pinned in <code>roster.lock</code>, next to init.lua.
      </p>
    </section>
  );
}
