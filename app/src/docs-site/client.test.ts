// The docs website's search box and results page (ticket 65), as a reader uses them: typing,
// the arrow keys, Enter, Escape and `/`, on the page's own markup (the frame site.tsx writes).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markPage, mountSearchBox, renderResults } from "./client";
import type { SearchIndex } from "./search";

const INDEX: SearchIndex = {
  topics: [
    ["options", "Options", "", "options.html"],
    ["terminal.size", "terminal.size", "The terminal's font size", "options.html#terminal.size"],
    ["terminal.font", "terminal.font", "The terminal's font", "options.html#terminal.font"],
    [":connect", ":connect", "Open a Session to HOST", "commands.html#%3Aconnect"],
    ["config#the-sandbox", "The sandbox", "Your init.lua", "config.html#the-sandbox"],
  ],
  places: [
    ["config.html#the-sandbox", "Your init.lua › The sandbox"],
    ["options.html#terminal.size", "Options › terminal.size"],
  ],
  texts: [
    [0, "init.lua runs in a <sandbox>: no os, no io."],
    [1, "terminal.size 13 The terminal's font size, in pixels."],
  ],
};

const HEADER = `<header><form class="site-go" action="search.html" role="search">
<label for="site-topic">:help</label>
<input id="site-topic" name="q" type="search">
</form></header><main id="main"><p>Some page</p><button>Other</button></main>`;

function setup(load: () => Promise<SearchIndex> = () => Promise.resolve(INDEX)) {
  document.body.innerHTML = HEADER;
  const go = vi.fn<(href: string) => void>();
  const input = document.getElementById("site-topic") as HTMLInputElement;
  mountSearchBox(input, { load, go });
  return { input, go, user: userEvent.setup() };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the search box", () => {
  it("is a combobox that names its list", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(document.getElementById(input.getAttribute("aria-controls") ?? "")).toHaveAttribute("role", "listbox");
  });

  it("lists matching topics, then the text, as you type, the first one chosen", async () => {
    const { input, user } = setup();
    await user.type(input, "sandbox");
    const list = await screen.findByRole("listbox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("The sandbox"),
      expect.stringContaining("init.lua runs in a <sandbox>"),
      expect.stringContaining("All 2 results"),
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(screen.getByRole("status")).toHaveTextContent("1 topic and 1 place in the text");
  });

  it("marks the words typed in a text result, as text, never as markup", async () => {
    const { input, user } = setup();
    await user.type(input, "sandbox");
    const option = (await screen.findAllByRole("option"))[1] as HTMLElement;
    expect(option.querySelector("mark")?.textContent).toBe("sandbox");
    expect(option.querySelector("sandbox")).toBeNull();
  });

  it("moves with the arrow keys and Ctrl+N / Ctrl+P, and Enter opens the one chosen", async () => {
    const { input, go, user } = setup();
    await user.type(input, "terminal");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Control>}n{/Control}{Control>}p{/Control}{ArrowUp}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(go).toHaveBeenCalledWith("options.html#terminal.font");
  });

  it("opens a text result at its place, asking the page to mark the word", async () => {
    const { input, go, user } = setup();
    await user.type(input, "pixels");
    await screen.findByRole("listbox");
    await user.keyboard("{Enter}");
    expect(go).toHaveBeenCalledWith("options.html?hl=pixels#terminal.size");
  });

  it("goes to every result from the last row", async () => {
    const { input, go, user } = setup();
    await user.type(input, "font size");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(go).toHaveBeenCalledWith("search.html?q=font%20size");
  });

  it("opens a result on a click", async () => {
    const { input, go, user } = setup();
    await user.type(input, "connect");
    await user.click(await screen.findByRole("option", { name: /:connect/ }));
    expect(go).toHaveBeenCalledWith("commands.html#%3Aconnect");
  });

  it("says so when nothing matches", async () => {
    const { input, user } = setup();
    await user.type(input, "zzzqqq");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No topic or text has zzzqqq"));
  });

  it("closes on Escape, empties on a second, and lets go of the focus on a third", async () => {
    const { input, user } = setup();
    await user.type(input, "sandbox");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("sandbox");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(input).not.toHaveFocus();
  });

  it("is focused by / from anywhere on the page but a field", async () => {
    const { input, user } = setup();
    await user.click(screen.getByRole("button", { name: "Other" }));
    await user.keyboard("/");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
  });

  it("loads the index once, when it's first used, and says so while it loads", async () => {
    let resolve: (i: SearchIndex) => void = () => {};
    const load = vi.fn(() => new Promise<SearchIndex>((r) => (resolve = r)));
    const { input, user } = setup(load);
    expect(load).not.toHaveBeenCalled();
    await user.type(input, "sand");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    resolve(INDEX);
    expect(await screen.findByRole("option", { name: /^The sandbox/ })).toBeInTheDocument();
    await user.type(input, "box");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says so when the index doesn't load", async () => {
    const { input, user } = setup(() => Promise.reject(new Error("gone")));
    await user.type(input, "sand");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The search index didn't load"));
  });
});

describe("the results page", () => {
  it("lists every topic and every place in the text, as links", () => {
    document.body.innerHTML = `<p id="site-count" role="status"></p><div id="site-results"></div>`;
    renderResults(document.getElementById("site-results") as HTMLElement, document.getElementById("site-count") as HTMLElement, INDEX, "font");
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["options.html#terminal.font", "options.html#terminal.size", "options.html?hl=font#terminal.size"]);
    expect(screen.getByRole("heading", { name: "Topics" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In the text" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 topics and 1 place in the text");
  });
});

describe("arriving from a text result", () => {
  it("marks the word on the page, the first one from the place on as the current one", () => {
    document.body.innerHTML = `<main><div class="help-doc"><p>a font here</p><h2 id="later">Later</h2><p>Font <code>font</code> again</p></div></main>`;
    markPage(document, "?hl=font", "#later");
    const marks = [...document.querySelectorAll("mark")];
    expect(marks.map((m) => m.textContent)).toEqual(["font", "Font", "font"]);
    expect(marks.map((m) => m.classList.contains("current"))).toEqual([false, true, false]);
    expect(document.querySelector("code")?.textContent).toBe("font");
  });

  it("does nothing without ?hl", () => {
    document.body.innerHTML = `<main><div class="help-doc"><p>a font here</p></div></main>`;
    markPage(document, "", "");
    expect(document.querySelector("mark")).toBeNull();
  });
});
