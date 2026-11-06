// `@tauri-apps/api/window` in the full-stack build: the browser page is the window. It never
// moves or maximizes; what the app calls on it does nothing.
const still = async () => () => {};

const page = {
  minimize: async () => {},
  toggleMaximize: async () => {},
  close: async () => {},
  setFullscreen: async (on: boolean) => {
    void on;
  },
  isMaximized: async () => false,
  isMinimized: async () => false,
  outerPosition: async () => ({ x: 0, y: 0 }),
  innerSize: async () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
  onResized: still,
  onMoved: still,
};

export function getCurrentWindow(): typeof page {
  return page;
}
