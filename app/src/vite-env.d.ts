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
  export const commands: { name: string; permission: string | null }[];
  export const roster_only: string[];
  export const tags: Record<string, string>;
}

/** What the help chunk reads of plugin-api.json: what the Lua stubs are written from (help/luaStubs.ts). */
declare module "*plugin-api.json?pick=api_version,values,modules,functions,events,types" {
  type Data = import("./help/luaStubs").StubsData;
  export const api_version: Data["api_version"];
  export const values: Data["values"];
  export const modules: Data["modules"];
  export const functions: Data["functions"];
  export const events: Data["events"];
  export const types: Data["types"];
}
