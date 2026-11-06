// `@tauri-apps/plugin-clipboard-manager` in the full-stack build: a clipboard of the page's own,
// which a test reads and sets (`window.e2eClipboard`), so it never touches the desktop's.
const clip = { text: "" };
(globalThis as unknown as { e2eClipboard: typeof clip }).e2eClipboard = clip;

export async function readText(): Promise<string> {
  return clip.text;
}

export async function writeText(text: string): Promise<void> {
  clip.text = text;
}
