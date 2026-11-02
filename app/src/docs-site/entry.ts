// search.js on the docs website (ticket 65): app/scripts/gen-docs-site.ts bundles this, with
// client.ts and what it imports, into one small script every page loads with `defer`.
import { start } from "./client";

start(document);
