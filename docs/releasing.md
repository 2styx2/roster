# Releasing

A Release is one version of the whole repo: the CLI and the app ship together, with one version number. `v0.1.0` came after iteration 4 and `v0.2.0` after iteration 7 (decisions Q48, Q70); the [roadmap](app/roadmap.md) says when the next one comes. Only the maintainer cuts a Release.

## What a Release holds

`.github/workflows/release.yml` builds all of it from the tagged commit and attaches it to a **draft** GitHub Release:

| File | What it is |
|---|---|
| `roster-app-X.Y.Z-windows-x64-setup.exe` | The Windows installer (NSIS), per user |
| `roster-app-X.Y.Z-windows-x64.msi` | The Windows installer (MSI), for managed installs |
| `roster-app-X.Y.Z-windows-x64.zip` | `roster-app.exe` and `LICENSE`, nothing installed (needs WebView2, which Windows 10 and 11 have) |
| `roster-app-X.Y.Z-linux-x64.AppImage` | Linux, one file, built on Ubuntu 22.04 so it runs on that and newer |
| `roster-app-X.Y.Z-linux-x64.deb` | Debian and Ubuntu |
| `roster-app-X.Y.Z-linux-x64.tar.gz` | The `roster-app` binary and `LICENSE` (needs WebKitGTK 4.1) |
| `roster-app-X.Y.Z-macos-universal.dmg` | macOS, Apple silicon and Intel in one app, ad-hoc signed |
| `roster-app-X.Y.Z-macos.tar.gz` | `Roster.app` and `LICENSE` |
| `roster-X.Y.Z-py3-none-any.whl`, `roster-X.Y.Z.tar.gz` | The CLI's wheel and sdist (`uv build`) |
| `roster-cli-X.Y.Z.tar.gz` | The CLI's source with `install.sh` and `LICENSE`, for a box without git: unpack, `./install.sh`. It has the man page at `share/man/man1/roster.1` too, laid out like a prefix |
| `roster.1` | The `roster(1)` man page on its own, for packagers (the wheel also installs it to `PREFIX/share/man/man1/`) |
| `roster-docs-X.Y.Z.pdf` | Every `:help` page in one document, printed by headless Chromium from the same pages as the docs website (`npm run docs -- --pdf`, ADR 0008) |
| `SHA256SUMS` | The SHA-256 of every file above |

The Release notes start with that version's section of [news.md](news.md) (what's new, changed, removed and deprecated, by area; `scripts/news_section.py` makes its links work on GitHub), then a short install note, then the pull requests merged since the last Release (GitHub's generated notes). The Version job fails a tag whose version has no section in `news.md`, before anything is built.

## One version

The version lives in nine files: `pyproject.toml`, `src/roster/__init__.py`, `uv.lock`, `app/package.json`, `app/package-lock.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `crates/roster-core/Cargo.toml` and `Cargo.lock`. Don't edit them by hand:

```bash
scripts/bump-version.sh 0.2.0     # sets all of them
scripts/bump-version.sh --check   # prints the version, or fails and names the files that differ
```

CI runs `--check` on every pull request, and the release workflow checks the tag against the files before it builds anything, so `v0.2.0` can't ship a build that says 0.1.0.

## Cutting a Release

1. **Bump the version** on a Work branch from `dev`, and land it like any change. The script also renames `docs/news.md`'s `## Unreleased` to `## v0.2.0`; read that section over, since it's the top of the Release's notes:

   ```bash
   git switch -c chore/release-0.2.0 origin/dev
   scripts/bump-version.sh 0.2.0
   git commit -am "chore: version 0.2.0"
   gh pr create --base dev
   ```

2. **Merge `dev` into `main`** with a pull request (`gh pr create --base main --head dev`), with CI green. A merge commit, as CONTRIBUTING.md says.

3. **Tag the merge commit on `main`** and push the tag:

   ```bash
   git fetch origin && git switch main && git merge --ff-only origin/main
   scripts/bump-version.sh --check          # should print 0.2.0
   git tag -a v0.2.0 -m "roster v0.2.0" && git push origin v0.2.0
   ```

4. **Wait for the draft.** The Release workflow takes about 12 minutes (the three app builds run side by side; macOS is the slowest). When it's done there's a draft Release named `roster v0.2.0` with every file above. Nobody else can see a draft.

5. **Check it.** Read the notes and cut what doesn't belong. Download the installer for your own platform, check it against `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`), install it, and open a Session. `uv tool install ./roster-0.2.0-py3-none-any.whl && roster --version` should print 0.2.0, and after `roster man --install`, `man roster` shows the page.

6. **Publish** the draft. The tag already exists, so publishing only makes it visible.

**The docs website** follows `main`, not the tag: merging `dev` into `main` in step 2 deploys it (`.github/workflows/docs.yml`, to <https://2styx2.github.io/roster/>), so the website shows the released docs by the time the draft is ready. It needs GitHub Pages turned on once: Settings → Pages → Source: **GitHub Actions**.

If a build fails, fix it on a Work branch, land it, and tag again: delete the draft and the tag (`git push --delete origin v0.2.0`, `git tag -d v0.2.0`), or use the next patch version if anyone has already seen the tag.

## Trying the builds without a Release

- **Run the workflow by hand:** Actions → Release → Run workflow (or `gh workflow run release.yml --ref BRANCH`). It builds everything and uploads it as workflow artifacts (`release-all` has every file and `SHA256SUMS`); it never creates a Release or a tag. GitHub only offers this once `release.yml` is on the default branch (`main`).
- **A pull request that changes `release.yml` or `scripts/bump-version.sh`** runs the same builds, so a change to the pipeline is tested before a tag needs it.

## Signing: not yet

Nothing is code-signed yet, so:

- **Windows:** SmartScreen says "Windows protected your PC" for the installers and the exe. "More info", then "Run anyway". It goes away once a signed build has built up reputation.
- **macOS:** the app is ad-hoc signed (`app/src-tauri/tauri.macos.conf.json`), not signed with a Developer ID or notarized, so Gatekeeper refuses to open it the first time. Right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Roster.app`.
- **Linux:** nothing checks a signature; `SHA256SUMS` is the check.

### Adding it later

Both are repository secrets, used only in the `app` job of `release.yml`, and Tauri reads them during `tauri build`.

**Windows** (an OV/EV certificate, or Azure Trusted Signing):

| Secret | What |
|---|---|
| `WINDOWS_CERTIFICATE` | The `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password |

Import it into the runner's certificate store in a step before the build (`Import-PfxCertificate`), then set `bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"` and `timestampUrl` in a `tauri.windows.conf.json`. With Azure Trusted Signing, use `bundle.windows.signCommand` instead, with `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`. Tauri's guide: <https://v2.tauri.app/distribute/sign/windows/>.

**macOS** (a Developer ID Application certificate and an Apple Developer account):

| Secret | What |
|---|---|
| `APPLE_CERTIFICATE` | The `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Its password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | For notarization (`APPLE_PASSWORD` is an app-specific password) |

Pass them as `env:` on the `tauri build` step for the macOS row and remove `tauri.macos.conf.json`'s `"signingIdentity": "-"`; Tauri imports the certificate, signs and notarizes. Tauri's guide: <https://v2.tauri.app/distribute/sign/macos/>.

**An auto-updater**, if one comes later, needs its own key pair: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
