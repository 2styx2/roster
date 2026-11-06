// The fake vault's password, in a module of its own with no imports, so the end-to-end suite
// (app/e2e, which runs in Node) types the same one the fake Backend checks.

/** The fake vault's master password (type it on the lock screen in a plain browser). */
export const FAKE_PASSWORD = "correct horse";
