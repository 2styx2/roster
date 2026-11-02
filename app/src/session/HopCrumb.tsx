// The breadcrumb after a Session's Host when a nested ssh took it to another one (ticket 120,
// decision Q131): an edge drawn from the Session's Host to the Host it's on now, then that Host's
// name, in Iosevka. One for the tab strip and the Sidebar's Sessions rows. The edge draws over
// --dur-draw as the connect edge does (taste.md: motion confirms), the name fades in; both go at
// once when the ssh ends. Reduced motion keeps the fade and drops the draw (the tokens do it).
// No accent: the Session's own row already carries the live bar.
import { hopWords, type Breadcrumb } from "./breadcrumb";

/** The breadcrumb; `spoken` adds its words for assistive tech where the container's name comes
 * from its text (a tab), and leaves them out where the name is given (a Sidebar row). */
export function HopCrumb({ hop, spoken = false }: { hop: Breadcrumb; spoken?: boolean }) {
  return (
    <span className={`hop${hop.known ? "" : " unknown"}`} title={hopWords(hop)}>
      <span className="hop-edge" aria-hidden="true" />
      <span className="hop-name" dir="auto" aria-hidden={spoken ? "true" : undefined}>
        {hop.to}
      </span>
      {spoken && <span className="visually-hidden">, {hopWords(hop)}</span>}
    </span>
  );
}
