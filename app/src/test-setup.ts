import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// How long findBy* and waitFor wait for what they look for before they give up (the default is
// 1 s). They return as soon as it's there, so this costs nothing when a test passes. Each App test
// renders the whole App in jsdom with React's development build; on a machine busy with other work
// (a full `npm run check` beside cargo builds) its first screen took over a second, and tests failed
// waiting for the sign-in dialog or the workspace that came a moment later (T146).
configure({ asyncUtilTimeout: 10_000 });
