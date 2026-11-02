// The docs website's search (ticket 65) in the browser: the top bar's box as a combobox (the
// ARIA pattern: the focus stays in the box, the arrow keys choose, Enter opens), the results page
// (search.html?q=…), and marking the word on the page a text result opens (`:helpgrep`'s `/WORD`).
// No framework: the site's pages are static HTML, and this is the only script they load. The
// index is a second script, loaded the first time the box is used (it's the biggest file).
//
// Nothing moves: the list is opened and walked from the keyboard, many times a visit, and motion
// there would only slow it (taste.md, "motion confirms"; emil-design-eng).
import { searchDocs, type SearchIndex, type SearchResults } from "./search";

/** How many of each the box lists; its last row goes to every result. */
const BOX_TOPICS = 6;
const BOX_TEXTS = 8;
/** How many places in the text the results page lists before asking for another word. */
const PAGE_TEXTS = 200;

export interface BoxDeps {
  /** The index, loaded the first time it's asked for. */
  load(): Promise<SearchIndex>;
  /** Opens an address on the site. */
  go(href: string): void;
}

const plural = (n: number, one: string, many: string) => `${n === 0 ? "No" : n} ${n === 1 ? one : many}`;

/** "2 topics and 1 place in the text". */
function countText(r: SearchResults): string {
  const topics = plural(r.topics.length, "topic", "topics");
  const texts = plural(r.texts.length, "place", "places").replace(/^No/, "no");
  return `${topics} and ${texts} in the text`;
}

/** `text` into `parent`, each of `terms` (lower case) in a <mark>. Text nodes only, never HTML. */
function appendMarked(parent: HTMLElement, text: string, terms: readonly string[]): void {
  const doc = parent.ownerDocument;
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let len = 0;
    for (const t of terms) {
      const i = lower.indexOf(t, at);
      if (i >= 0 && (next < 0 || i < next || (i === next && t.length > len))) [next, len] = [i, t.length];
    }
    if (next < 0) break;
    if (next > at) parent.append(text.slice(at, next));
    const mark = doc.createElement("mark");
    mark.textContent = text.slice(next, next + len);
    parent.append(mark);
    at = next + len;
  }
  if (at < text.length) parent.append(text.slice(at));
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A topic's name: Iosevka when it's something you'd type (`terminal.size`, `:connect`), Inter
 * when it's a heading's words. */
function topicRow(doc: Document, t: SearchResults["topics"][number], terms: readonly string[]): HTMLElement[] {
  const name = el(doc, "span", t.label === t.tag ? "site-hit-name site-hit-tag" : "site-hit-name");
  appendMarked(name, t.label, terms);
  return t.path ? [name, el(doc, "span", "site-hit-where", t.path)] : [name];
}

function textRow(doc: Document, t: SearchResults["texts"][number], terms: readonly string[]): HTMLElement[] {
  const text = el(doc, "span", "site-hit-name");
  appendMarked(text, t.label, terms);
  return [text, el(doc, "span", "site-hit-where", t.where)];
}

let boxes = 0;

/** Makes the top bar's search field a combobox over the index. */
export function mountSearchBox(input: HTMLInputElement, deps: BoxDeps): void {
  const doc = input.ownerDocument;
  const form = input.form;
  const n = boxes++;
  const listId = `site-hits-${n}`;

  const pop = el(doc, "div", "site-pop");
  pop.hidden = true;
  const msg = el(doc, "p", "site-pop-msg");
  msg.setAttribute("aria-hidden", "true");
  const list = el(doc, "div", "site-hits");
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Search results");
  pop.append(msg, list);
  const status = el(doc, "p", "visually-hidden");
  status.setAttribute("role", "status");
  (form ?? input.parentElement ?? doc.body).append(pop, status);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);

  let index: SearchIndex | null = null;
  let loading: Promise<void> | null = null;
  let failed = false;
  let hrefs: string[] = [];
  let active = 0;

  const ensure = () => {
    loading ??= deps.load().then(
      (i) => {
        index = i;
        update();
      },
      () => {
        failed = true;
        update();
      },
    );
  };

  const choose = (i: number) => {
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    if (options.length === 0) return;
    active = ((i % options.length) + options.length) % options.length;
    options.forEach((o, k) => o.setAttribute("aria-selected", String(k === active)));
    const current = options[active] as HTMLElement;
    input.setAttribute("aria-activedescendant", current.id);
    current.scrollIntoView?.({ block: "nearest" });
  };

  const close = () => {
    pop.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const say = (text: string) => {
    msg.textContent = text;
    msg.hidden = text === "";
  };

  function update(): void {
    const query = input.value.trim();
    list.replaceChildren();
    hrefs = [];
    if (!query) {
      status.textContent = "";
      return close();
    }
    if (!index) {
      const text = failed ? "The search index didn't load. Reload the page to try again." : "Loading the search index…";
      say(text);
      status.textContent = text;
      pop.hidden = false;
      input.setAttribute("aria-expanded", "false");
      return;
    }
    const r = searchDocs(index, query);
    const terms = r.terms ?? [];
    if (r.topics.length + r.texts.length === 0) {
      const text = `No topic or text has ${query}.`;
      say(text);
      status.textContent = text;
      pop.hidden = false;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    say("");
    const group = (label: string, rows: { href: string; cells: HTMLElement[]; kind: string }[]) => {
      if (rows.length === 0) return;
      const g = el(doc, "div", "site-hits-group");
      g.setAttribute("role", "group");
      if (label) {
        const head = el(doc, "div", "site-hits-head", label);
        head.id = `${listId}-g${list.children.length}`;
        head.setAttribute("role", "presentation");
        g.setAttribute("aria-labelledby", head.id);
        g.append(head);
      }
      for (const row of rows) {
        const o = el(doc, "div", `site-hit site-hit-${row.kind}`);
        o.id = `${listId}-o${hrefs.length}`;
        o.setAttribute("role", "option");
        o.setAttribute("aria-selected", "false");
        o.dataset.href = row.href;
        o.append(...row.cells);
        hrefs.push(row.href);
        g.append(o);
      }
      list.append(g);
    };
    group(
      "Topics",
      r.topics.slice(0, BOX_TOPICS).map((t) => ({ href: t.href, cells: topicRow(doc, t, terms), kind: "topic" })),
    );
    group(
      "In the text",
      r.texts.slice(0, BOX_TEXTS).map((t) => ({ href: t.href, cells: textRow(doc, t, terms), kind: "text" })),
    );
    const total = r.topics.length + r.texts.length;
    group("", [{ href: `search.html?q=${encodeURIComponent(query)}`, cells: [el(doc, "span", "site-hit-name", `All ${total} results`)], kind: "all" }]);
    status.textContent = countText(r);
    pop.hidden = false;
    input.setAttribute("aria-expanded", "true");
    choose(0);
  }

  const open = (i: number, newTab: boolean) => {
    const href = hrefs[i];
    if (href === undefined) return;
    if (newTab) doc.defaultView?.open(href, "_blank", "noopener");
    else deps.go(href);
  };

  input.addEventListener("focus", () => {
    ensure();
    if (input.value.trim()) update();
  });
  input.addEventListener("input", () => {
    ensure();
    update();
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    const expanded = input.getAttribute("aria-expanded") === "true";
    const next = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n");
    const prev = e.key === "ArrowUp" || (e.ctrlKey && e.key === "p");
    if (next || prev) {
      e.preventDefault();
      if (!expanded) return update();
      choose(active + (next ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (expanded) open(active, e.ctrlKey || e.metaKey);
      else if (input.value.trim()) deps.go(`search.html?q=${encodeURIComponent(input.value.trim())}`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!pop.hidden) close();
      else if (input.value) {
        input.value = "";
        status.textContent = "";
      } else input.blur();
    }
  });
  // A click keeps the focus in the box, and a hover chooses, as the arrow keys do.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (o) open(hrefs.indexOf(o.dataset.href ?? ""), e.ctrlKey || e.metaKey);
  });
  list.addEventListener("mousemove", (e) => {
    const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
    const i = o ? [...list.querySelectorAll('[role="option"]')].indexOf(o) : -1;
    if (i >= 0 && i !== active) choose(i);
  });
  form?.addEventListener("submit", (e) => e.preventDefault());

  // `/` from anywhere but a field, as in Neovim (and most docs sites).
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !input.isConnected) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}

/** search.html's list: every topic and every place in the text (the first PAGE_TEXTS). */
export function renderResults(out: HTMLElement, count: HTMLElement, index: SearchIndex, query: string): void {
  const doc = out.ownerDocument;
  out.replaceChildren();
  if (!query.trim()) {
    count.textContent = "Type words to search every page: topics as :help finds them, and the text as :helpgrep does.";
    return;
  }
  const r = searchDocs(index, query);
  const terms = r.terms ?? [];
  if (r.topics.length + r.texts.length === 0) {
    count.textContent = `No topic or text has ${query.trim()}. Every topic is on the all page.`;
    const all = el(doc, "p");
    const a = el(doc, "a", "help-link", "Every topic");
    a.href = "all.html";
    all.append(a);
    out.append(all);
    return;
  }
  count.textContent = countText(r);
  const section = (title: string, rows: { href: string; cells: HTMLElement[] }[], more = 0) => {
    if (rows.length === 0) return;
    out.append(el(doc, "h2", undefined, title));
    const ul = el(doc, "ul", "site-results");
    for (const row of rows) {
      const li = el(doc, "li");
      const a = el(doc, "a", "site-result");
      a.href = row.href;
      a.append(...row.cells);
      li.append(a);
      ul.append(li);
    }
    out.append(ul);
    if (more > 0) out.append(el(doc, "p", "site-search-more", `And ${more} more. Add a word to narrow it down.`));
  };
  section(
    "Topics",
    r.topics.map((t) => ({ href: t.href, cells: topicRow(doc, t, terms) })),
  );
  section(
    "In the text",
    r.texts.slice(0, PAGE_TEXTS).map((t) => ({ href: t.href, cells: textRow(doc, t, terms) })),
    r.texts.length - PAGE_TEXTS,
  );
}

/** Arriving from a text result (`page.html?hl=WORD#place`): marks the word in the page, and the
 * first one from the place on is the current one, as the help panel's `/` search does. */
export function markPage(doc: Document, search: string, hash: string): HTMLElement | null {
  const word = new URLSearchParams(search).get("hl")?.trim().toLowerCase();
  const root = doc.querySelector<HTMLElement>("main .help-doc");
  if (!word || !root) return null;
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.toLowerCase().includes(word)) nodes.push(n as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const span = doc.createElement("span");
    appendMarked(span, node.data, [word]);
    marks.push(...span.querySelectorAll("mark"));
    node.replaceWith(...span.childNodes);
  }
  let place: Element | null = null;
  try {
    place = hash.length > 1 ? doc.getElementById(decodeURIComponent(hash.slice(1))) : null;
  } catch {
    place = null;
  }
  const current =
    marks.find((m) => !place || place === m || place.contains(m) || (place.compareDocumentPosition(m) & 4) /* FOLLOWING */ !== 0) ?? marks[0] ?? null;
  current?.classList.add("current");
  return current;
}

/** Loads search-index.js as a script (works from file:// too, where fetch doesn't). */
function loadIndex(doc: Document): Promise<SearchIndex> {
  return new Promise((resolve, reject) => {
    const win = doc.defaultView as (Window & { rosterSearchIndex?: SearchIndex }) | null;
    if (win?.rosterSearchIndex) return resolve(win.rosterSearchIndex);
    const s = doc.createElement("script");
    s.src = "search-index.js";
    s.onload = () => (win?.rosterSearchIndex ? resolve(win.rosterSearchIndex) : reject(new Error("no index")));
    s.onerror = () => reject(new Error("search-index.js didn't load"));
    doc.head.append(s);
  });
}

/** Everything search.js does on a page. */
export function start(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;
  let pending: Promise<SearchIndex> | null = null;
  const load = () => (pending ??= loadIndex(doc));
  const go = (href: string) => win.location.assign(href);
  const box = doc.getElementById("site-topic");
  if (box instanceof HTMLInputElement) mountSearchBox(box, { load, go });

  const out = doc.getElementById("site-results");
  const count = doc.getElementById("site-count");
  const field = doc.getElementById("site-q");
  if (out && count && field instanceof HTMLInputElement) {
    const query = new URLSearchParams(win.location.search).get("q") ?? "";
    field.value = query;
    if (box instanceof HTMLInputElement) box.value = query;
    count.textContent = query.trim() ? "Loading the search index…" : "";
    const show = () =>
      load().then(
        (index) => renderResults(out, count, index, field.value),
        () => (count.textContent = "The search index didn't load. Reload the page to try again."),
      );
    void show();
    field.addEventListener("input", () => {
      const url = new URL(win.location.href);
      if (field.value.trim()) url.searchParams.set("q", field.value);
      else url.searchParams.delete("q");
      win.history.replaceState(null, "", url);
      void show();
    });
    field.form?.addEventListener("submit", (e) => e.preventDefault());
    if (!query) field.focus();
  }

  const current = markPage(doc, win.location.search, win.location.hash);
  if (current) {
    const r = current.getBoundingClientRect();
    if (r.top < 48 || r.bottom > win.innerHeight) current.scrollIntoView({ block: "center" });
  }
}
