/// <reference types="vite/client" />

/** THIRD-PARTY-NOTICES at the repo's root, as text (scripts/notices-plugin.mjs, T180). */
declare module "virtual:third-party-notices" {
  const text: string;
  export default text;
}

/** Every guide's topics, made when the app is built (scripts/help-plugin.mjs, src/help/tagTable.ts, T213). */
declare module "virtual:help-tags" {
  const tags: Record<string, import("./help/guideBlocks").PageTag[]>;
  export default tags;
}

/** The parts of plugin-api.json startup reads (scripts/help-plugin.mjs's `?pick=`, T213): the rest is
 * the help chunk's. */
declare module "*plugin-api.json?pick=api_version,commands,roster_only,tags" {
  export const api_version: number;
  export const commands: { name: string; permission: string | null; doc: string; needs_text: string }[];
  export const roster_only: string[];
  export const tags: Record<string, string>;
}

/** What the help chunk reads of plugin-api.json: what the Lua stubs (help/luaStubs.ts) and the reference
 * (help/pluginApiDoc.ts) are written from, but the commands, which startup's pick has. */
declare module "*plugin-api.json?pick=api_version,values,modules,functions,events,types,serve_results,lua_doc,errors_doc" {
  type Data = import("./help/pluginApiDoc").DocData;
  export const api_version: Data["api_version"];
  export const values: Data["values"];
  export const modules: Data["modules"];
  export const functions: Data["functions"];
  export const events: Data["events"];
  export const types: Data["types"];
  export const serve_results: Data["serve_results"];
  export const lua_doc: Data["lua_doc"];
  export const errors_doc: Data["errors_doc"];
}
