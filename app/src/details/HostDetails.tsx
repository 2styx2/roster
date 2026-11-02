// The Host details panel (ticket 18, spec stories 79-80, decision Q71): what `roster info HOST`
// shows, as a side panel opposite the Sidebar, closed until asked for (`:info HOST`, the tree's and
// the Picker's info control, the toolbar's toggle, `␣ i`). Each web service has an Open button that
// hands its URL to the default browser (`:open SERVICE` does the same). Logins show their vault
// reference, the Vault item's name; roster never sends a secret, and a password written into a URL
// is never drawn. It opens from a key as often as a click, so like every side panel it doesn't
// animate (taste.md: motion confirms, and a key is its own confirmation).
import type { Host, HostList } from "../backend/types";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { HeadActions, runHeadKey } from "../view/ViewContent";
import { Keys } from "../ui/Keys";
import { countOf } from "../ui/format";
import { hostFacts, serviceRows } from "./details";
import { ViewContent } from "../view/ViewContent";
import type { DetailsSectionDef } from "../view/views";

export interface HostDetailsProps {
  host: Host;
  groups: HostList["groups"];
  /** Opens a web service's URL in the default browser (the app says what happened). */
  onOpen(service: string, url: string): void;
  onClose(): void;
  /** `:open`'s keys hint: the command line's keys, or null when hints are off. */
  cmdlineKeys: string | null;
  leader: string;
  /** Sections Plugins add for this Host (ticket 76), in order. */
  sections?: readonly DetailsSectionDef[];
}

/** An arrow out of a box: it leaves the app, for the default browser. */
const OutGlyph = () => (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 2h3v3M10 2L5.5 6.5M8.5 7.5V10h-6.5V3.5H4.5" />
  </svg>
);

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function HostDetails({ host, groups, onOpen, onClose, cmdlineKeys, leader, sections = [] }: HostDetailsProps) {
  const facts = hostFacts(host, groups);
  const services = serviceRows(host);
  const problems = host.problems ?? [];
  const anyWeb = services.some((s) => s.open !== null);
  return (
    <aside className="side-panel host-details" aria-label={`Details of ${host.name}`}>
      <header>
        <h2>
          <span className="muted">Details · </span>
          <span className="mono" dir="auto">
            {host.name}
          </span>
        </h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close the Host details" onMouseDown={keepFocus} onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <dl className="details-facts">
        {facts.map((f) => (
          <div key={f.label} className="details-fact">
            <dt>{f.label}</dt>
            <dd className={f.data ? "mono" : undefined} dir="auto">
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      <h3 className="details-heading">
        Services <span className="details-count">{services.length > 0 ? countOf(services.length, "service") : ""}</span>
      </h3>
      {services.length === 0 ? (
        <p className="panel-empty-line muted">No services in roster.yml.</p>
      ) : (
        <ul className="details-services" aria-label="Services">
          {services.map((s) => (
            <li key={s.name} className="details-service">
              <div className="svc-line">
                <span className="svc-name mono" title={s.name}>
                  {s.name}
                </span>
                <span className="svc-port mono">{s.port}</span>
                {s.open !== null && (
                  <button
                    type="button"
                    className="svc-open"
                    aria-label={`Open ${s.name} in the browser`}
                    title={s.open}
                    onMouseDown={keepFocus}
                    onClick={() => onOpen(s.name, s.open as string)}
                  >
                    Open <OutGlyph />
                  </button>
                )}
              </div>
              {s.url && <div className="svc-url mono">{s.url}</div>}
              <div className="svc-login mono">{s.login}</div>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <>
          <h3 className="details-heading">Left out</h3>
          <ul className="details-problems">
            {problems.map((p) => (
              <li key={p.service}>
                <span>{p.message}</span> <span className="muted">Fix: {p.fix}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {sections.map((s) => (
        <section key={s.id} className="details-section" aria-label={`${s.title} (from ${s.source})`} onKeyDown={(e) => runHeadKey(e, s.content.actions)}>
          <h3 className="details-heading">
            {s.title} <span className="details-count">{s.source}</span>
            {s.content.actions?.length ? (
              <span className="details-head-actions">
                <HeadActions actions={s.content.actions} />
              </span>
            ) : null}
          </h3>
          <ViewContent content={s.content} label={`${s.title} of ${host.name}`} leader={leader} />
        </section>
      ))}
      {anyWeb && (
        <p className="details-foot muted key-hint">
          {cmdlineKeys ? (
            <>
              <Keys keys={cmdlineKeys} leader={leader} /> <code>open SERVICE</code> opens one too
            </>
          ) : (
            <>
              <code>:open SERVICE</code> opens one too
            </>
          )}
        </p>
      )}
    </aside>
  );
}
