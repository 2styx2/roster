// The help panel (`:help`, ticket 37): one page at a time beside the terminal (over it in Focus or
// a narrow window), like the Key bindings panel. Keyboard first: j/k and Ctrl+D/U scroll, g g / G
// jump, Tab and Enter follow links, Ctrl+O / Ctrl+I go back and forward, / searches the page (n / N
// for the next and previous match), ? finds another topic, Esc closes and puts focus back where it
// was. It opens from a key, so nothing animates.
//
// Prose is Inter; code, names and values are Iosevka; keys are keycaps. Its keycaps are the
// bindings themselves (`binding-keys`), so `ui.hints = false` never hides them.
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import "./doc.css";
import { Announce } from "../ui/Announce";
import { Keys } from "../ui/Keys";
import { highlight, shellCommand } from "./highlight";
import type { HelpSnapshot, HelpView } from "./command";
import type { Block, Def, Inline } from "./doc";
import { linkKind, pageBody, topics, type HelpContext } from "./pages";

export interface HelpPanelProps {
  view: HelpView;
  snapshot: HelpSnapshot;
  ctx: HelpContext;
  leader: string;
  vim: boolean;
  /** Opens the topic finder. */
  onFind(): void;
  /** Opens the outline of the page shown (`g O`). */
  onOutline(): void;
  /** The page's search changed (`:tutor` waits for some, ticket 55). */
  onSearch?(page: string, query: string): void;
}

/** What inline rendering needs: the search, the Leader, and which code is a topic. The docs
 * website (src/docs-site, ticket 46) renders pages with this same renderer, giving it the last
 * three to make topics real web addresses. */
export interface RenderEnv {
  query: string;
  leader: string;
  tags: ReadonlySet<string>;
  /** The topic shown (a code span naming it isn't linked to itself). */
  here: string | undefined;
  open(tag: string): void;
  /** Inside a link already: a code span in it isn't linked again. */
  inLink?: boolean;
  /** Where a topic link goes; `#help:TAG` in the app. */
  href?(tag: string): string;
  /** The element id of a topic on the page; the app gives none (it finds them by `data-tag`). */
  id?(tag: string): string | undefined;
  /** The page a topic link leads to, when that's another page (the PDF prints "→ page"). */
  pageOf?(tag: string): string | undefined;
  /** A file or web link's address; in the app they stay text, with where they go as a tooltip. */
  outside?(href: string): string | undefined;
}

const Env = createContext<RenderEnv>({ query: "", leader: "", tags: new Set(), here: undefined, open: () => {} });

const LINE = 40;

export function HelpPanel({ view, snapshot, ctx, leader, vim, onFind, onOutline, onSearch }: HelpPanelProps) {
  const at = snapshot.at;
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  const pending = useRef<string | null>(null);
  // A place that came with a search (`:helpgrep`, `:help TOPIC /TEXT`) puts it in the search field
  // (searchSeq), and its first match from the anchor on becomes the current one (placedSeq).
  const [searchSeq, setSearchSeq] = useState(-1);
  const [placedSeq, setPlacedSeq] = useState(-1);
  if (at?.search && searchSeq !== snapshot.seq) {
    setSearchSeq(snapshot.seq);
    setQuery(at.search);
    setHit(0);
  }

  const page = ctx.pages.find((p) => p.id === at?.page);
  const blocks = useMemo(() => (at ? pageBody(ctx, at.page) : []), [ctx, at]);
  const tags = useMemo(() => new Set(topics(ctx).map((t) => t.tag)), [ctx]);
  const env: RenderEnv = { query, leader, tags, here: at?.anchor ?? at?.page, open: (tag) => view.openTopic(tag) };

  // Focus comes to the page when help opens, and goes back where it was when it closes.
  useLayoutEffect(() => {
    const before = document.activeElement;
    scrollRef.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if ((lost || now.closest(".help-panel")) && before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // A new place: to its entry, or the top.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const anchor = at?.anchor;
    const el = anchor ? [...scroller.querySelectorAll<HTMLElement>("[data-tag]")].find((e) => e.dataset.tag === anchor) : undefined;
    if (el) el.scrollIntoView?.({ block: "start" });
    else scroller.scrollTop = 0;
    if (!scroller.contains(document.activeElement) || document.activeElement === document.body) scroller.focus({ preventScroll: true });
  }, [at, snapshot.seq]);

  // The matches, after each render of a search: count them and mark the current one.
  useLayoutEffect(() => {
    const marks = [...(scrollRef.current?.querySelectorAll("mark.help-hit") ?? [])];
    if (searchSeq === snapshot.seq && placedSeq !== snapshot.seq && marks.length && query === at?.search) {
      setPlacedSeq(snapshot.seq);
      const anchor = at?.anchor;
      const from = anchor ? scrollRef.current?.querySelector(`[data-tag="${CSS.escape(anchor)}"]`) : null;
      const first = from ? marks.findIndex((m) => from.contains(m) || !!(from.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)) : 0;
      if (first > 0) return setHit(first);
    }
    setHits(marks.length);
    const current = marks.length ? ((hit % marks.length) + marks.length) % marks.length : 0;
    marks.forEach((m, i) => m.classList.toggle("current", i === current));
    marks[current]?.scrollIntoView?.({ block: "center" });
  }, [hit, query, blocks, at, searchSeq, placedSeq, snapshot.seq]);

  const count = query ? (hits ? `${(((hit % hits) + hits) % hits) + 1} of ${hits}` : "No matches") : "";
  const step = (by: number) => setHit((h) => (hits ? (((h + by) % hits) + hits) % hits : 0));

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const inSearch = e.target === searchRef.current;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (inSearch) {
      if (k === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSearching(false);
        scrollRef.current?.focus({ preventScroll: true });
      } else if (k === "Enter") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
      return;
    }
    const scroller = scrollRef.current;
    const by = (px: number) => scroller?.scrollBy?.({ top: px });
    const seq = pending.current;
    pending.current = null;
    let handled = true;
    if (seq === "g" && k === "O") onOutline();
    else if (k === "Escape" || (k === "q" && !ctrl)) view.close();
    else if (ctrl && k === "]") {
      // Neovim's Ctrl+]: follow the link you're on (Enter does too).
      const on = document.activeElement;
      if (on instanceof HTMLElement && on.matches(".help-link")) on.click();
    }
    else if (ctrl && k === "o") view.goBack();
    else if (ctrl && k === "i") view.goForward();
    else if (e.altKey && k === "ArrowLeft") view.goBack();
    else if (e.altKey && k === "ArrowRight") view.goForward();
    else if (ctrl && k === "d") by((scroller?.clientHeight ?? 400) / 2);
    else if (ctrl && k === "u") by(-(scroller?.clientHeight ?? 400) / 2);
    else if (ctrl) handled = false;
    else if (k === "/") {
      setSearching(true);
      setHit(0);
      // At once, never a frame later (a key typed in that frame would be replaced). A field already there holds
      // the last search: select it so typing replaces it. A new one is empty, and the effect below focuses it.
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (k === "n" && query) step(1);
    else if (k === "N" && query) step(-1);
    else if (k === "?") onFind();
    else if (vim && k === "j") by(LINE);
    else if (vim && k === "k") by(-LINE);
    else if (vim && k === "G" && scroller) scroller.scrollTop = scroller.scrollHeight;
    else if (k === "g") {
      if (seq === "g" && vim && scroller) scroller.scrollTop = 0;
      else pending.current = "g";
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const searchedPage = at?.page;
  useEffect(() => {
    if (searchedPage && query) onSearch?.(searchedPage, query);
  }, [searchedPage, query, onSearch]);

  // Focus on the search field as it appears.
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  if (!at) return null;
  return (
    <aside className="help-panel" aria-label="Help" onKeyDown={onKeyDown}>
      <header>
        <p className="help-where" title={`:help ${at.anchor ?? at.page}`}>
          <span className="help-prompt">:help</span> {at.anchor ?? at.page}
        </p>
        <span className="help-nav">
          <button type="button" className="icon-button" aria-label="Back" title="Back (Ctrl+O)" disabled={!snapshot.canBack} onClick={() => view.goBack()}>
            ‹
          </button>
          <button type="button" className="icon-button" aria-label="Forward" title="Forward (Ctrl+I)" disabled={!snapshot.canForward} onClick={() => view.goForward()}>
            ›
          </button>
          <button type="button" className="help-find" title="This page's headings (g O)" onClick={onOutline}>
            Outline
          </button>
          <button type="button" className="help-find" title="Find a topic (?)" onClick={onFind}>
            Topics
          </button>
          <PanelButton />
          <button type="button" className="icon-button" aria-label="Close help" onClick={() => view.close()}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      {searching || query ? (
        <div className="help-search">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search this page"
            placeholder="Search this page…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHit(0);
            }}
          />
          <span className="help-count" aria-hidden="true">
            {count}
          </span>
        </div>
      ) : null}
      {/* Mounted, empty, for as long as help is open, so the count is heard when a search
          (`:helpgrep`, `:help TOPIC /TEXT`) arrives with the page (ticket 54). */}
      <Announce text={count} delay={150} />
      <div className="help-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={page?.title ?? at.page}>
        <Env value={env}>
          <article className="help-doc">
            {page ? blocks.map((b, i) => <BlockView key={i} block={b} target={at.anchor} />) : <p>No help page named {at.page}.</p>}
          </article>
        </Env>
      </div>
      <p className="panel-foot key-hint">
        <Keys keys="/" /> search <Keys keys="Tab" /> links <Keys keys="Ctrl+o" /> back <Keys keys="g O" /> outline <Keys keys="?" /> topics <Keys keys="Esc" /> close
      </p>
    </aside>
  );
}

/** A page's blocks as the help panel draws them, for rendering outside the panel (the docs
 * website renders this to static HTML). */
export function HelpDoc({ blocks, env }: { blocks: readonly Block[]; env: RenderEnv }) {
  return (
    <Env value={env}>
      <article className="help-doc">
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} target={undefined} />
        ))}
      </article>
    </Env>
  );
}

function BlockView({ block: b, target }: { block: Block; target: string | undefined }) {
  const env = useContext(Env);
  switch (b.t) {
    case "h": {
      const Tag = `h${b.level}` as const;
      return (
        <Tag id={env.id?.(b.anchor)} data-tag={b.anchor} className={target === b.anchor ? "help-target" : undefined}>
          {/* A page's title names the page: nothing in it links back to it. */}
          {b.level === 1 ? (
            <NoLinks>
              <Inlines items={b.text} />
            </NoLinks>
          ) : (
            <Inlines items={b.text} />
          )}
        </Tag>
      );
    }
    case "p":
      return (
        <p>
          <Inlines items={b.text} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <Inlines items={b.text} />
        </blockquote>
      );
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L>
          {b.items.map((item, i) => (
            <li key={i}>
              <Inlines items={item} />
            </li>
          ))}
        </L>
      );
    }
    case "pre":
      return (
        <pre data-lang={b.lang}>
          <code>
            <Code text={b.text} lang={b.lang} />
          </code>
        </pre>
      );
    case "table":
      return (
        <div className="help-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} scope="col">
                    <Inlines items={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => {
                const tag = b.anchors?.[r];
                return (
                  <tr key={r} id={tag ? env.id?.(tag) : undefined} data-tag={tag} className={tag && tag === target ? "help-target" : undefined}>
                    {row.map((c, i) => (
                      <td key={i}>
                        <Inlines items={c} spaced="parts" />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    case "step":
      // A node, as the Sidebar's are: a ring while it's to do, filled with a ✓ once the app saw
      // it done. The change is the one motion help has (taste: motion that confirms).
      return (
        <p className="help-step" data-done={b.done ? "" : undefined}>
          <span className="help-step-node" aria-hidden="true">
            <svg viewBox="0 0 12 12" focusable="false">
              <path d="M3.2 6.3 5.1 8.1 8.8 4.2" />
            </svg>
          </span>
          <span className="visually-hidden">{b.done ? "Done: " : "To do: "}</span>
          <span className="help-step-text">
            <Inlines items={b.text} />
          </span>
        </p>
      );
    case "defs":
      return (
        <dl className="help-defs">
          {b.items.map((d, i) => (
            <DefView key={d.anchor ?? i} def={d} target={target} />
          ))}
        </dl>
      );
  }
}

function DefView({ def: d, target }: { def: Def; target: string | undefined }) {
  const env = useContext(Env);
  return (
    <div id={d.anchor ? env.id?.(d.anchor) : undefined} data-tag={d.anchor} data-tone={d.tone} className={d.anchor && d.anchor === target ? "help-def help-target" : "help-def"}>
      <dt>
        <span className="help-term">
          {/* The entry's own name isn't a link (to itself). */}
          <NoLinks>
            <Inlines items={d.term} />
          </NoLinks>
        </span>
        {d.meta.length > 0 && (
          <span className="help-meta">
            <Inlines items={d.meta} spaced="all" />
          </span>
        )}
      </dt>
      <dd>
        <Inlines items={d.body} />
      </dd>
      {d.more && (
        <dd className="help-def-more">
          <Inlines items={d.more} />
        </dd>
      )}
    </div>
  );
}

/** Inline content. `spaced="all"` puts a gap between every part (a def's meta: separate facts);
 * `"parts"` only between keycaps and code side by side (a cell's `␣ f` `␣ F`), so words next to
 * them keep their own spacing. */
function Inlines({ items, spaced }: { items: readonly Inline[]; spaced?: "all" | "parts" }) {
  return (
    <>
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 && (spaced === "all" || (spaced === "parts" && it.t !== "text" && items[i - 1]?.t !== "text")) ? " " : null}
          <InlineView item={it} />
        </Fragment>
      ))}
    </>
  );
}

function InlineView({ item }: { item: Inline }): ReactNode {
  const env = useContext(Env);
  switch (item.t) {
    case "text":
      return <Highlighted text={item.text} />;
    case "code": {
      // `␣ K`, `Ctrl+o` or `Esc` in a guide is a key: keycaps, like everywhere else.
      if (isKeys(item.text)) return <Keys keys={item.text} leader={env.leader} className="binding-keys" />;
      // A code span naming a topic links to it: `:connect`, `terminal.size`, `init.lua`.
      const tag = codeTopic(item.text, env.tags);
      // A `:command` reads as one; a shell line (`roster sync --dry-run`) is coloured as in a block.
      const shell = shellCommand(item.text);
      const el = item.text.startsWith(":") ? (
        <code className="help-cmd">
          <Highlighted text={item.text} />
        </code>
      ) : shell ? (
        <code className="help-shell">
          <Code text={item.text} lang="sh" />
        </code>
      ) : (
        <code>
          <Highlighted text={item.text} />
        </code>
      );
      return tag && tag !== env.here && !env.inLink ? <TopicLink tag={tag}>{el}</TopicLink> : el;
    }
    case "strong":
      return (
        <strong>
          <Inlines items={item.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines items={item.children} />
        </em>
      );
    case "keys":
      return <Keys keys={item.keys} leader={env.leader} className="binding-keys" />;
    case "link": {
      const children = <Inlines items={item.children} />;
      const kind = linkKind(item.href);
      // A file in the repo that isn't in help, or a web page: its text, with where it goes (a link
      // on the website).
      if (kind !== "topic") {
        const to = env.outside?.(item.href);
        if (to) return <a className="help-link" href={to}>{children}</a>;
        return (
          <span className="help-file" title={item.href.replace(/^file:/, "")}>
            {children}
          </span>
        );
      }
      return env.tags.has(item.href) ? <TopicLink tag={item.href}>{children}</TopicLink> : children;
    }
  }
}

/** Keymap notation: `␣`, `␣ K`, `Ctrl+o`, `Ctrl+Shift+c`, `Esc`, `Tab`, `F11`, `g O`. */
const isKeys = (code: string): boolean =>
  /^␣( \S+)*$/.test(code) ||
  /^(?:(?:Ctrl|Alt|Shift|Meta|Cmd)\+)+\S+$/.test(code) ||
  /^(?:Esc|Tab|Enter|Shift\+Tab|F\d{1,2})$/.test(code) ||
  /^g [gO]$/.test(code);

function NoLinks({ children }: { children: ReactNode }) {
  const env = useContext(Env);
  return <Env value={{ ...env, inLink: true }}>{children}</Env>;
}

/** The topic a code span names, if it's one: itself, what `:help TOPIC` opens, or a command
 * line's command (`:source init.lua`). */
function codeTopic(code: string, tags: ReadonlySet<string>): string | null {
  if (tags.has(code)) return code;
  const asked = /^:help (\S+)$/.exec(code)?.[1];
  if (asked && tags.has(asked)) return asked;
  const cmd = /^:(\S+)/.exec(code)?.[1];
  return cmd && tags.has(`:${cmd}`) ? `:${cmd}` : null;
}

function TopicLink({ tag, children }: { tag: string; children: ReactNode }) {
  const env = useContext(Env);
  return (
    <a
      className="help-link"
      href={env.href ? env.href(tag) : `#help:${tag}`}
      data-page={env.pageOf?.(tag)}
      title={`:help ${tag}`}
      onClick={(e) => {
        e.preventDefault();
        env.open(tag);
      }}
    >
      <Env value={{ ...env, inLink: true }}>{children}</Env>
    </a>
  );
}

/** Code coloured by its language (highlight.ts), with the search's matches marked. A match is one
 * `<mark>` around the coloured runs it covers, so the panel counts it once. */
function Code({ text, lang }: { text: string; lang: string | undefined }) {
  const { query } = useContext(Env);
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);
  if (tokens.length === 1 && !tokens[0]?.kind) return <Highlighted text={text} />;
  // Each run with where it starts, so a match's range can take the slices it covers.
  const starts: number[] = [];
  tokens.reduce((at, t) => (starts.push(at), at + t.text.length), 0);
  const slice = (from: number, to: number): ReactNode[] =>
    tokens.flatMap((t, k) => {
      const a = Math.max(from, starts[k] as number);
      const b = Math.min(to, (starts[k] as number) + t.text.length);
      if (a >= b) return [];
      const part = t.text.slice(a - (starts[k] as number), b - (starts[k] as number));
      return [t.kind ? <span key={`${k}-${a}`} className={`hl-${t.kind}`}>{part}</span> : part];
    });
  if (!query) return <>{slice(0, text.length)}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    parts.push(...slice(from, i));
    parts.push(
      <mark key={`m${i}`} className="help-hit">
        {slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
  }
  parts.push(...slice(from, text.length));
  return <>{parts}</>;
}

/** Text with the search's matches marked. */
function Highlighted({ text }: { text: string }) {
  const { query } = useContext(Env);
  if (!query) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark key={i} className="help-hit">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

