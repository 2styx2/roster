import type { Plugin } from "vite";

/** `FILE.json?pick=a,b`: only those top-level keys of a JSON file, as named exports (T213). */
export declare const jsonPick: Plugin;
/** `virtual:help-tags`: every guide's topics, made at build time (src/help/tagTable.ts, T213). */
export declare const helpTags: Plugin;
