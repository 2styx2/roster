#!/usr/bin/env bash
# Run the Linux build of the app with its own data, under WSLg, X11 or Wayland, and measure it
# (ticket 20, docs/app/dev/linux.md).
#
#   app/scripts/linux-run.sh build            build it from this checkout (tauri build --no-bundle); needs the
#                                             WebKitGTK 4.1 dev packages (it prints the command when they're missing)
#   app/scripts/linux-run.sh fetch [RUN_ID]   or take CI's build instead (artifact roster-app-linux) with
#                                             `gh run download`: RUN_ID, else this branch's latest green CI run with a build,
#                                             else dev's
#   app/scripts/linux-run.sh run [opts]       start it (OPENS A WINDOW) and wait until it's closed
#   app/scripts/linux-run.sh measure [opts]   the same with the paste text on the clipboard; open the Host
#                                             `latency` (␣ f latency Enter), paste when it asks, read `:info`,
#                                             close the window; then the report
#   app/scripts/linux-run.sh report           the last results as rows for docs/app/performance.md
#   app/scripts/linux-run.sh stop             stop a run left behind
#
# run/measure options: --example  the real `roster serve` of this checkout on a copy of examples/roster.example.yml
#                                 (default: the stand-in serve, app/scripts/perf/serve.py: made-up Hosts, no vault)
#                      --x11      GDK_BACKEND=x11 (XWayland under WSLg or a Wayland desktop)
#                      --no-dmabuf, --no-compositing   WebKitGTK's WEBKIT_DISABLE_DMABUF_RENDERER=1 and
#                                 WEBKIT_DISABLE_COMPOSITING_MODE=1, for a blank or flickering window
#
# Env: ROSTER_APP_LINUX_DIR (default ~/.cache/roster-app-linux): the binary (bin/), the run's own HOME with its
# XDG config, data, cache and state dirs (home/), the State (state/), the results (results/) and the log
# (run.log). PERF_HOSTS (1284), PERF_RATE (lines a second per Session, 100), PERF_PASTE_KB (1024).
#
# It never touches your own data: the app runs with HOME and every XDG dir inside that folder and without
# ROSTER_CONFIG, so it finds no Inventory, init.lua, State or vault of yours; the stand-in serve answers
# everything and no Host is reached.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
dir="${ROSTER_APP_LINUX_DIR:-$HOME/.cache/roster-app-linux}"
bin="$dir/bin/roster-app"
what="${1:-}"
shift || true

missing_build_deps() {
  pkg-config --exists webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0 2>/dev/null && return 1
  echo "The WebKitGTK 4.1 development packages are missing. Install them (once), then build again:" >&2
  if command -v dnf >/dev/null; then
    echo "  sudo dnf install -y webkit2gtk4.1-devel openssl-devel libxdo-devel librsvg2-devel libappindicator-gtk3-devel && sudo dnf group install -y development-tools" >&2
  else
    echo "  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev build-essential pkg-config" >&2
  fi
  echo "Or use CI's build: $0 fetch" >&2
  return 0
}

missing_run_deps() {
  local gone
  gone="$(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}')"
  [ -z "$gone" ] && return 1
  echo "The app needs libraries this system doesn't have: $(echo "$gone" | tr '\n' ' ')" >&2
  if command -v dnf >/dev/null; then
    echo "  sudo dnf install -y webkit2gtk4.1 gtk3 libsoup3" >&2
  else
    echo "  sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0" >&2
  fi
  return 0
}

# The paste check's text on the clipboard: the Windows one under WSLg (it's shared), else Wayland's or X11's.
clipboard() {
  local text
  text="$(python3 -I "$here/perf/latency.py" --paste-text "${PERF_PASTE_KB:-1024}")"
  if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v clip.exe >/dev/null; then
    printf '%s' "$text" | clip.exe
  elif [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null; then
    printf '%s' "$text" | wl-copy
  elif command -v xclip >/dev/null; then
    printf '%s' "$text" | xclip -selection clipboard
  else
    echo "No clipboard tool (clip.exe, wl-copy or xclip): the paste check will wait, then skip." >&2
  fi
}

start() {
  local example=0 x11=0 no_dmabuf=0 no_comp=0
  for a in "$@"; do
    case "$a" in
      --example) example=1 ;;
      --x11) x11=1 ;;
      --no-dmabuf) no_dmabuf=1 ;;
      --no-compositing) no_comp=1 ;;
      *) echo "unknown option $a" >&2; exit 2 ;;
    esac
  done
  [ -x "$bin" ] || { echo "No build in $dir/bin yet: run '$0 build' or '$0 fetch'." >&2; exit 1; }
  if missing_run_deps; then exit 1; fi
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "No display (DISPLAY or WAYLAND_DISPLAY)." >&2; exit 1; }
  local h="$dir/home" roster
  mkdir -p "$h/.config" "$h/.local/share" "$h/.cache" "$h/.local/state" "$dir/state" "$dir/results"
  if [ "$example" = 1 ]; then
    cp "$repo/examples/roster.example.yml" "$h/roster.yml"
    roster="$(command -v uv) run --project $repo roster"
  else
    rm -f "$h/roster.yml"
    roster="python3 $here/perf/serve.py --hosts ${PERF_HOSTS:-1284} --rate ${PERF_RATE:-100} --latency $dir/results"
  fi
  local env=(
    -u ROSTER_CONFIG -u ROSTER_DESK_ROSTER -u ROSTER_DESK_STATE_DIR -u ROSTER_APP_WSL_DISTRO
    HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_DATA_HOME="$h/.local/share" XDG_CACHE_HOME="$h/.cache"
    XDG_STATE_HOME="$h/.local/state" ROSTER_APP_STATE_DIR="$dir/state" ROSTER_APP_ROSTER="$roster"
  )
  [ "$example" = 1 ] && env+=(UV_CACHE_DIR="$(uv cache dir)")
  [ "$x11" = 1 ] && env+=(GDK_BACKEND=x11)
  [ "$no_dmabuf" = 1 ] && env+=(WEBKIT_DISABLE_DMABUF_RENDERER=1)
  [ "$no_comp" = 1 ] && env+=(WEBKIT_DISABLE_COMPOSITING_MODE=1)
  echo "Starting $bin (opens a window; its data is in $dir). Close the window to finish." >&2
  env "${env[@]}" "$bin" >"$dir/run.log" 2>&1 &
  echo $! >"$dir/pid"
  wait "$(cat "$dir/pid")" || true
  rm -f "$dir/pid"
}

case "$what" in
  build)
    if missing_build_deps; then exit 1; fi
    cd "$repo/app"
    [ -d node_modules ] || npm ci
    npm run tauri build -- --no-bundle
    mkdir -p "$dir/bin"
    cp "$repo/target/release/roster-app" "$bin"
    echo "Built: $bin" >&2
    ;;
  fetch)
    run_id="${1:-}"
    tmp="$(mktemp -d)"
    if [ -n "$run_id" ]; then
      gh run download "$run_id" -R 2styx2/roster -n roster-app-linux -D "$tmp"
    else
      # A pull request builds the app only when it touches the Rust or the Tauri build (docs/development.md,
      # "What CI runs when"), so a green run may have no build: then dev's, which every push builds.
      got=""
      for b in "$(git -C "$repo" branch --show-current)" dev; do
        run_id="$(gh run list -R 2styx2/roster -w CI -b "$b" -s success -L 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
        if [ -n "$run_id" ] && gh run download "$run_id" -R 2styx2/roster -n roster-app-linux -D "$tmp" 2>/dev/null; then
          got=1; break
        fi
      done
      [ -n "$got" ] || { rm -rf "$tmp"; echo "No green CI run with a Linux build found; pass a RUN_ID." >&2; exit 1; }
    fi
    mkdir -p "$dir/bin"
    install -m 755 "$tmp/roster-app" "$bin"
    rm -rf "$tmp"
    echo "CI run $run_id: $bin" >&2
    missing_run_deps || true
    ;;
  run)
    start "$@"
    ;;
  measure)
    clipboard
    start "$@"
    "$0" report
    ;;
  report)
    last="$(ls -t "$dir"/results/latency-*.json 2>/dev/null | head -1 || true)"
    [ -n "$last" ] || { echo "No results yet: open the Host 'latency' in a '$0 measure' run." >&2; exit 1; }
    python3 -I "$here/perf/latency.py" --report "$last"
    ;;
  stop)
    [ -f "$dir/pid" ] && kill "$(cat "$dir/pid")" 2>/dev/null || true
    pkill -f "$here/perf/serve.py" 2>/dev/null || true
    rm -f "$dir/pid"
    ;;
  *)
    sed -n '2,29p' "$0" >&2
    exit 2
    ;;
esac
