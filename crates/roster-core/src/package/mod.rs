//! Packages (ticket 24, ADR 0006, decisions Q81 and Q83; docs/plugins.md, "Packages"): Plugins
//! fetched from git repos, the way lazy.nvim fetches Neovim's.
//!
//! `init.lua` names each one (`packages = { { "owner/repo", tag = "v1.0.0" } }`, checked by
//! [`check_specs`]); [`Packages`] keeps a clone of each in the app's own data folder and pins the
//! commit in `roster.lock`, next to `init.lua`, so the lock can live in dotfiles. A Package may
//! load its Plugin from a folder of the repo (`dir = "plugins/topology"`, decision Q94): the clone
//! is still the whole repo, one per Package, and the folder must stay inside it. The interface
//! is what the app does with them:
//!
//! - [`Packages::sync`] at start and after `init.lua` changes: clones what's missing and checks
//!   out what the lock pins (or, for a new Package, what `init.lua` asks for). With the clones and
//!   the lock in place it needs no network.
//! - [`Packages::pin`] once the user allowed the install prompt; [`Packages::discard`] when they
//!   cancelled it, so nothing is left.
//! - [`Packages::check`] for `:packages update`: fetches, and describes each new commit (log,
//!   diff, the new manifest) without changing anything; [`Packages::apply`] moves to one the user
//!   saw and allowed.
//! - [`Packages::clean`] removes what `init.lua` no longer names; [`Packages::remove`] one.
//!
//! Trust: nothing is cloned that isn't named in `init.lua` (every operation takes the specs, and
//! a name the specs don't have is refused), git runs with no shell and no credentials from
//! roster ([`git`]), and loading the code is the Plugin host's business, behind the same prompts
//! as any Plugin.

pub mod git;

use crate::config::PackageSpec;
pub use git::Git;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The lock file's name, next to `init.lua`.
pub const LOCK_FILE: &str = "roster.lock";
/// The clones' folder inside the app's data folder.
pub const CLONES_DIR: &str = "packages";
/// The most of a diff `:packages update` shows.
pub const MAX_DIFF: usize = 256 * 1024;
/// The most commits it lists.
pub const MAX_LOG: usize = 50;

/// What `roster.lock` keeps for a Package: where it came from and the commit it's at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockEntry {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The folder in the repo the Plugin loads from, when it isn't the top (decision Q94).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    pub commit: String,
}

/// `roster.lock`: Package name → entry, in name order (so it diffs well in dotfiles).
pub type Lock = BTreeMap<String, LockEntry>;

/// A Package as `:packages` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub name: String,
    /// As init.lua writes it (`owner/repo`).
    pub source: String,
    /// The git URL that means.
    pub url: String,
    /// The folder in the repo the Plugin loads from (`plugins/topology`); none for the top.
    pub dir: Option<String>,
    /// What init.lua asks for: `tag v1.0.0`, `branch main`, `commit 1a2b3c4`, `default branch`.
    pub wants: String,
    /// The commit its clone is at, if it has one.
    pub commit: Option<String>,
    /// The commit `roster.lock` pins, if it pins one for this source.
    pub locked: Option<String>,
    /// Installed: the lock pins the commit the clone is at. Not yet: waiting for the install prompt.
    pub pinned: bool,
    /// The settings init.lua hands it (`roster.plugin.config`).
    pub config: Json,
    /// Something the user should know (init.lua names another version than the lock).
    pub note: Option<String>,
    /// Why it couldn't be cloned or checked out.
    pub error: Option<String>,
}

/// A newer commit for a Package, as `:packages update` shows it before applying it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub from: String,
    pub to: String,
    /// `1a2b3c4 Subject`, newest first (at most [`MAX_LOG`]).
    pub log: Vec<String>,
    /// `git diff --stat`.
    pub stat: String,
    /// The diff itself, cut to [`MAX_DIFF`].
    pub diff: String,
    pub truncated: bool,
    /// The new version's manifest (its permissions are compared with what was asked before).
    pub manifest: Option<crate::plugin::Manifest>,
    pub manifest_error: Option<String>,
}

/// One Package's answer to [`Packages::check`]: an update, an error, or neither (up to date).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Checked {
    pub name: String,
    pub update: Option<Update>,
    pub error: Option<String>,
}

/// The clones and the lock, and the git that keeps them. One operation at a time.
pub struct Packages {
    clones: PathBuf,
    lock: PathBuf,
    git: Git,
    busy: Mutex<()>,
}

type Invalid = (Vec<String>, String);

/// Checks init.lua's `packages`: each source is one roster can fetch, each name is usable and
/// different (letter case aside: Windows folders ignore it), at most one of tag, branch, commit.
pub fn check_specs(specs: &[PackageSpec]) -> Result<(), Invalid> {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (i, spec) in specs.iter().enumerate() {
        let n = (i + 1).to_string();
        let at = |key: &str| vec!["packages".to_string(), n.clone(), key.to_string()];
        url_of(&spec.source).map_err(|m| (at("source"), m))?;
        if let Some(d) = &spec.dir {
            subfolder(d).map_err(|m| (at("dir"), m))?;
        }
        let name_key = match (&spec.name, &spec.dir) {
            (Some(_), _) => "name",
            (None, Some(_)) => "dir",
            _ => "source",
        };
        let name = name_of(spec).map_err(|m| (at(name_key), m))?;
        let pins = [&spec.tag, &spec.branch, &spec.commit];
        if pins.iter().filter(|p| p.is_some()).count() > 1 {
            return Err((at("tag"), "one of tag, branch or commit, not several".into()));
        }
        for (key, value) in [("tag", &spec.tag), ("branch", &spec.branch)] {
            if let Some(v) = value {
                check_ref(v).map_err(|m| (at(key), m))?;
            }
        }
        if let Some(c) = &spec.commit
            && !(4..=40).contains(&c.len())
        {
            return Err((at("commit"), format!("{c:?} isn't a commit (4 to 40 hex digits)")));
        }
        if let Some(c) = &spec.commit
            && !c.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err((at("commit"), format!("{c:?} isn't a commit (4 to 40 hex digits)")));
        }
        if let Some(first) = seen.insert(name.to_lowercase(), i + 1) {
            return Err((
                at("source"),
                format!("package {first} is named {name} too: give one of them name = \"…\""),
            ));
        }
    }
    Ok(())
}

fn check_ref(v: &str) -> Result<(), String> {
    let bad = v.is_empty()
        || v.len() > 200
        || v.starts_with(['-', '/'])
        || v.contains("..")
        || v.chars()
            .any(|c| c.is_whitespace() || c.is_control() || ":^~?*[\\".contains(c));
    if bad {
        Err(format!("{v:?} isn't a usable git tag or branch name"))
    } else {
        Ok(())
    }
}

/// The git URL a source means: `owner/repo` is on GitHub; a full URL (`https://`, `ssh://`,
/// `git@host:path`, `file://`) or a full path to a repo on this machine is used as it is.
pub fn url_of(source: &str) -> Result<String, String> {
    let s = source.trim();
    let word = |w: &str| {
        !w.is_empty() && !w.starts_with(['-', '.']) && w.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    if s.is_empty() {
        return Err("which repo? \"owner/repo\" or a git URL".into());
    }
    if s.chars().any(|c| c.is_whitespace() || c.is_control()) || s.starts_with('-') {
        return Err(format!("{s:?} isn't a git URL or \"owner/repo\""));
    }
    if s.starts_with("http://") || s.starts_with("git://") {
        return Err(format!(
            "{s}: plain {} can be changed on the way; use https:// or ssh://",
            s.split(':').next().unwrap_or("http")
        ));
    }
    if ["https://", "ssh://", "file://"].iter().any(|p| s.starts_with(p)) {
        return Ok(s.to_string());
    }
    if s.contains("://") || s.contains("::") {
        return Err(format!("{s}: roster fetches over https://, ssh:// or file:// only"));
    }
    if is_absolute(s) {
        return Ok(s.to_string());
    }
    if let Some((user_host, path)) = s.split_once(':')
        && let Some((user, host)) = user_host.split_once('@')
        && word(user)
        && !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
        && !path.is_empty()
    {
        return Ok(s.to_string());
    }
    match s.split('/').collect::<Vec<_>>()[..] {
        [owner, repo] if word(owner) && word(repo) => Ok(format!(
            "https://github.com/{owner}/{}.git",
            repo.trim_end_matches(".git")
        )),
        _ => Err(format!(
            "{s:?} isn't \"owner/repo\" or a git URL (https://, ssh://, git@host:path, file:// or a full path)"
        )),
    }
}

fn is_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/') || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
}

/// A Package's `dir` as roster keeps it (`plugins/topology`, no `./` or trailing `/`), or why it
/// can't be one: it must name a folder inside the repo, relative, with `/` between folders, never
/// `..` or `.git` (decision Q94). Symlinks are checked once the clone is there.
pub fn subfolder(dir: &str) -> Result<String, String> {
    let d = dir.trim();
    if d.chars().any(|c| c.is_control()) {
        return Err(format!("{d:?} isn't a folder name"));
    }
    if d.starts_with(['/', '\\']) || is_absolute(d) || d.contains(':') {
        return Err(format!(
            "dir = {d:?}: a folder inside the repo, like \"plugins/topology\", not a full path"
        ));
    }
    if d.contains('\\') {
        return Err(format!("dir = {d:?}: use / between folders"));
    }
    let parts: Vec<&str> = d.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.contains(&"..") {
        return Err(format!(
            "dir = {d:?}: \"..\" would leave the repo; name a folder inside it"
        ));
    }
    if parts.iter().any(|p| p.eq_ignore_ascii_case(".git")) {
        return Err(format!(
            "dir = {d:?}: not inside .git; name a folder of the repo's files"
        ));
    }
    if parts.is_empty() {
        return Err("which folder? dir = \"plugins/NAME\", or leave dir out for the repo's top".into());
    }
    Ok(parts.join("/"))
}

/// A Package's name: `name = …`, else its folder's when it has a `dir` (`topology` for
/// `plugins/topology`), else its repo's (`recent-alerts` for `…/recent-alerts.git`).
pub fn name_of(spec: &PackageSpec) -> Result<String, String> {
    if let Some(n) = &spec.name {
        return if valid_name(n) {
            Ok(n.clone())
        } else {
            Err(format!(
                "{n:?} isn't a Package name (letters, digits, . _ -; not starting with . or -)"
            ))
        };
    }
    if let Some(d) = &spec.dir {
        let d = subfolder(d)?;
        let last = d.rsplit('/').next().unwrap_or_default();
        return if valid_name(last) {
            Ok(last.to_string())
        } else {
            Err(format!("can't name a Package after the folder {d:?}: add name = \"…\""))
        };
    }
    let url = url_of(&spec.source)?;
    let last = url
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or_default();
    let name = last.strip_suffix(".git").unwrap_or(last);
    if valid_name(name) {
        Ok(name.to_string())
    } else {
        Err(format!("can't name a Package after {url:?}: add name = \"…\""))
    }
}

fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 100
        && !n.starts_with(['.', '-'])
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn wants(spec: &PackageSpec) -> String {
    match (&spec.tag, &spec.branch, &spec.commit) {
        (Some(t), _, _) => format!("tag {t}"),
        (_, Some(b), _) => format!("branch {b}"),
        (_, _, Some(c)) => format!("commit {c}"),
        _ => "default branch".into(),
    }
}

/// The spec's `dir`, as roster keeps it; none for the repo's top (or a `dir` check_specs refuses).
fn dir_of(spec: &PackageSpec) -> Option<String> {
    spec.dir.as_deref().and_then(|d| subfolder(d).ok())
}

/// The lock line is for what init.lua names: the same repo and folder.
fn same_source(e: &LockEntry, spec: &PackageSpec, url: &str) -> bool {
    e.source == url && e.dir == dir_of(spec)
}

/// The lock line pins the version init.lua asks for (else `:packages update` moves it).
fn wants_match(e: &LockEntry, spec: &PackageSpec) -> bool {
    e.tag == spec.tag
        && e.branch == spec.branch
        && spec.commit.as_ref().is_none_or(|c| e.commit.starts_with(c.as_str()))
}

fn is_commit(c: &str) -> bool {
    c.len() == 40 && c.chars().all(|c| c.is_ascii_hexdigit())
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(7)]
}

impl Packages {
    /// Packages with their clones under `data_dir` (in [`CLONES_DIR`]) and the lock in
    /// `config_dir` ([`LOCK_FILE`]).
    pub fn new(data_dir: &Path, config_dir: &Path) -> Self {
        Self::with_git(data_dir, config_dir, Git::default())
    }

    pub fn with_git(data_dir: &Path, config_dir: &Path, git: Git) -> Self {
        Packages {
            clones: data_dir.join(CLONES_DIR),
            lock: config_dir.join(LOCK_FILE),
            git,
            busy: Mutex::new(()),
        }
    }

    /// The lock file's path.
    pub fn lock_path(&self) -> &Path {
        &self.lock
    }

    /// What `roster.lock` says now (empty if there's none).
    pub fn lock(&self) -> Result<Lock, String> {
        match std::fs::read_to_string(&self.lock) {
            Ok(text) if text.trim().is_empty() => Ok(Lock::new()),
            Ok(text) => {
                let lock: Lock = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.lock.display()))?;
                for (name, e) in &lock {
                    if !valid_name(name) || !is_commit(&e.commit) {
                        return Err(format!(
                            "{}: {name}: not a Package name with a full commit id",
                            self.lock.display()
                        ));
                    }
                }
                Ok(lock)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Lock::new()),
            Err(e) => Err(format!("can't read {}: {e}", self.lock.display())),
        }
    }

    fn write_lock(&self, lock: &Lock) -> Result<(), String> {
        let text = serde_json::to_string_pretty(lock).map_err(|e| e.to_string())? + "\n";
        crate::config::write_atomic(&self.lock, &text).map_err(|e| format!("can't write {}: {e}", self.lock.display()))
    }

    /// The folder of a Package `specs` names, and the settings init.lua hands it, for loading it
    /// as a Plugin. Refused for a name init.lua doesn't have, or one not cloned yet.
    pub fn loadable(&self, specs: &[PackageSpec], name: &str) -> Result<(PathBuf, Json), String> {
        let spec = find(specs, name)?;
        let dir = self.clones.join(name);
        if !dir.join(".git").exists() {
            return Err(format!("the Package {name} isn't fetched yet"));
        }
        Ok((self.plugin_dir(&dir, spec)?, Json::Object(spec.config.clone())))
    }

    /// The folder in a clone the Plugin loads from: the clone, or its `dir`, which must be a
    /// folder there and, after symlinks, still inside the clone (decision Q94).
    fn plugin_dir(&self, clone: &Path, spec: &PackageSpec) -> Result<PathBuf, String> {
        let Some(sub) = dir_of(spec) else {
            return Ok(clone.to_path_buf());
        };
        let path = clone.join(&sub);
        if !path.is_dir() {
            let at = self
                .head(clone)
                .map(|c| format!(" at {}", short(&c)))
                .unwrap_or_default();
            return Err(format!(
                "{}{at} has no folder {sub}: check dir in init.lua",
                url_of(&spec.source).unwrap_or_default()
            ));
        }
        // The Plugin host's rule for every file of a Plugin (crate::plugin::folder::inside),
        // and not into git's own folder either.
        let escape =
            || format!("dir = {sub:?} leads outside the Package's clone (through a symlink): roster won't load it");
        let top = clone.canonicalize().map_err(|e| format!("{}: {e}", clone.display()))?;
        let inside = crate::plugin::folder::inside(clone, Path::new(&sub)).map_err(|_| escape())?;
        if inside.starts_with(top.join(".git")) {
            return Err(escape());
        }
        Ok(inside)
    }

    /// Makes each Package's clone match the lock: clones what's missing and checks out the
    /// pinned commit. A Package the lock doesn't pin yet gets what init.lua asks for and stays
    /// unpinned until [`Packages::pin`]. Uses the network only to clone, or when the pinned
    /// commit isn't in the clone.
    pub fn sync(&self, specs: &[PackageSpec]) -> Vec<Status> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let lock = self.lock();
        specs
            .iter()
            .map(|spec| {
                let mut status = self.blank(spec);
                let lock = match &lock {
                    Ok(l) => l,
                    Err(e) => {
                        status.error = Some(e.clone());
                        return status;
                    }
                };
                if let Err(e) = self.sync_one(spec, lock, &mut status) {
                    status.error = Some(e);
                }
                status
            })
            .collect()
    }

    fn blank(&self, spec: &PackageSpec) -> Status {
        Status {
            name: name_of(spec).unwrap_or_else(|_| spec.source.clone()),
            source: spec.source.clone(),
            url: url_of(&spec.source).unwrap_or_default(),
            dir: dir_of(spec),
            wants: wants(spec),
            commit: None,
            locked: None,
            pinned: false,
            config: Json::Object(spec.config.clone()),
            note: None,
            error: None,
        }
    }

    fn sync_one(&self, spec: &PackageSpec, lock: &Lock, status: &mut Status) -> Result<(), String> {
        let name = name_of(spec)?;
        let url = url_of(&spec.source)?;
        let dir = self.clones.join(&name);
        let entry = lock.get(&name).filter(|e| same_source(e, spec, &url));
        // init.lua now names another repo for this name: the old clone is different code.
        if dir.exists() && self.origin(&dir).as_deref() != Some(url.as_str()) {
            remove_dir(&dir)?;
        }
        if !dir.exists() {
            self.clone(&url, &dir)?;
        }
        let target = match entry {
            Some(e) => self.have(&dir, &e.commit, &url)?,
            None => self.resolve(&dir, spec)?,
        };
        if self.head(&dir).as_deref() != Some(target.as_str()) {
            self.checkout(&dir, &target)?;
        }
        let head = self.head(&dir);
        status.commit = head.clone();
        status.locked = entry.map(|e| e.commit.clone());
        status.pinned = entry.is_some_and(|e| Some(&e.commit) == head.as_ref());
        if let Some(e) = entry
            && !wants_match(e, spec)
        {
            status.note = Some(format!(
                "init.lua asks for {}; roster.lock pins {}: :packages update moves it",
                wants(spec),
                short(&e.commit)
            ));
        }
        self.plugin_dir(&dir, spec)?;
        Ok(())
    }

    /// Pins the commit a Package's clone is at in `roster.lock` (the user allowed it).
    pub fn pin(&self, specs: &[PackageSpec], name: &str) -> Result<Status, String> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let spec = find(specs, name)?;
        let dir = self.clones.join(name);
        let head = self
            .head(&dir)
            .ok_or_else(|| format!("the Package {name} isn't fetched"))?;
        self.write_entry(spec, name, &head)?;
        let mut status = self.blank(spec);
        status.commit = Some(head.clone());
        status.locked = Some(head);
        status.pinned = true;
        Ok(status)
    }

    fn write_entry(&self, spec: &PackageSpec, name: &str, commit: &str) -> Result<(), String> {
        let mut lock = self.lock()?;
        lock.insert(
            name.to_string(),
            LockEntry {
                source: url_of(&spec.source)?,
                tag: spec.tag.clone(),
                branch: spec.branch.clone(),
                dir: dir_of(spec),
                commit: commit.to_string(),
            },
        );
        self.write_lock(&lock)
    }

    /// Removes a Package's clone, leaving the lock as it is: the install prompt was cancelled.
    pub fn discard(&self, name: &str) -> Result<(), String> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !valid_name(name) {
            return Err(format!("{name:?} isn't a Package name"));
        }
        remove_dir(&self.clones.join(name))
    }

    /// Removes a Package's clone and its line in `roster.lock` (`:plugins remove`).
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !valid_name(name) {
            return Err(format!("{name:?} isn't a Package name"));
        }
        let mut lock = self.lock()?;
        if lock.remove(name).is_some() {
            self.write_lock(&lock)?;
        }
        remove_dir(&self.clones.join(name))
    }

    /// `:packages update`, step 1: fetches each pinned Package and describes the commit init.lua
    /// now asks for, if it's another one. Changes nothing but the clones' remote refs.
    pub fn check(&self, specs: &[PackageSpec]) -> Vec<Checked> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        specs
            .iter()
            .filter_map(|spec| {
                let name = name_of(spec).ok()?;
                let dir = self.clones.join(&name);
                if !dir.join(".git").exists() {
                    return None;
                }
                let (update, error) = match self.check_one(spec, &dir, &name) {
                    Ok(u) => (u, None),
                    Err(e) => (None, Some(e)),
                };
                Some(Checked { name, update, error })
            })
            .collect()
    }

    /// `:packages update NAME`: [`Packages::check`] for the one Package init.lua names `name`,
    /// fetching only it. An error when init.lua names no such Package or it isn't cloned.
    pub fn check_named(&self, specs: &[PackageSpec], name: &str) -> Result<Checked, String> {
        let spec = specs
            .iter()
            .find(|s| name_of(s).ok().as_deref() == Some(name))
            .ok_or_else(|| format!("init.lua names no Package {name}"))?;
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = self.clones.join(name);
        if !dir.join(".git").exists() {
            return Err(format!(
                "{name} isn't installed: :packages install {name} asks to install it"
            ));
        }
        let (update, error) = match self.check_one(spec, &dir, name) {
            Ok(u) => (u, None),
            Err(e) => (None, Some(e)),
        };
        Ok(Checked {
            name: name.to_string(),
            update,
            error,
        })
    }

    fn check_one(&self, spec: &PackageSpec, dir: &Path, name: &str) -> Result<Option<Update>, String> {
        self.git.run(
            Some(dir),
            &["fetch", "--quiet", "--tags", "--force", "--prune", "origin"],
        )?;
        // The remote's default branch may have moved.
        let _ = self.git.run(Some(dir), &["remote", "set-head", "origin", "--auto"]);
        let to = self.resolve(dir, spec)?;
        let from = self.head(dir).ok_or("its clone has no commit")?;
        if from == to {
            return Ok(None);
        }
        let sub = dir_of(spec);
        // A Package from a folder of a bigger repo: commits that leave its folder as it was
        // aren't an update to it (unless init.lua now asks for another version than the lock).
        if let Some(sub) = &sub {
            let tree = |c: &str| {
                self.git
                    .run(Some(dir), &["rev-parse", "--verify", "--quiet", &format!("{c}:{sub}")])
                    .ok()
            };
            let url = url_of(&spec.source)?;
            let pinned_as_asked = self
                .lock()?
                .get(name)
                .is_some_and(|e| same_source(e, spec, &url) && wants_match(e, spec));
            if pinned_as_asked && tree(&from).is_some() && tree(&from) == tree(&to) {
                return Ok(None);
            }
        }
        // Only the Package's folder: the rest of the repo isn't loaded.
        let only: Vec<&str> = sub.as_deref().map(|s| vec!["--", s]).unwrap_or_default();
        let range = format!("{from}..{to}");
        let max = format!("--max-count={MAX_LOG}");
        let log = self
            .git
            .run(
                Some(dir),
                &[&["log", "--format=%h %s", &max, &range][..], &only].concat(),
            )?
            .lines()
            .map(str::to_string)
            .collect();
        let stat = self
            .git
            .run(Some(dir), &[&["diff", "--stat", &from, &to][..], &only].concat())?;
        let mut diff = self.git.run(Some(dir), &[&["diff", &from, &to][..], &only].concat())?;
        let truncated = diff.len() > MAX_DIFF;
        if truncated {
            let mut cut = MAX_DIFF;
            while !diff.is_char_boundary(cut) {
                cut -= 1;
            }
            diff.truncate(cut);
        }
        let manifest_at = match &sub {
            Some(s) => format!("{s}/{}", crate::plugin::MANIFEST),
            None => crate::plugin::MANIFEST.to_string(),
        };
        let (manifest, manifest_error) = match self.git.run(Some(dir), &["show", &format!("{to}:{manifest_at}")]) {
            Ok(text) => match crate::plugin::manifest_from(&text, name) {
                Ok(m) => (Some(m), None),
                Err(e) => (None, Some(e.to_string())),
            },
            Err(_) => (None, Some(format!("the new version has no {manifest_at}"))),
        };
        Ok(Some(Update {
            from,
            to,
            log,
            stat,
            diff,
            truncated,
            manifest,
            manifest_error,
        }))
    }

    /// `:packages update`, step 2: moves a Package to `commit` (one [`Packages::check`] showed
    /// and the user allowed) and pins it.
    pub fn apply(&self, specs: &[PackageSpec], name: &str, commit: &str) -> Result<Status, String> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let spec = find(specs, name)?;
        if !is_commit(commit) {
            return Err(format!("{commit:?} isn't a full commit id"));
        }
        let dir = self.clones.join(name);
        self.git
            .run(Some(&dir), &["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .map_err(|_| format!("{} isn't in {name}'s clone: run :packages update again", short(commit)))?;
        let before = self.head(&dir);
        self.checkout(&dir, commit)?;
        // The new version's folder must still be one roster loads; else it stays where it was.
        if let Err(e) = self.plugin_dir(&dir, spec) {
            if let Some(b) = before {
                let _ = self.checkout(&dir, &b);
            }
            return Err(e);
        }
        self.write_entry(spec, name, commit)?;
        let mut status = self.blank(spec);
        status.commit = Some(commit.to_string());
        status.locked = Some(commit.to_string());
        status.pinned = true;
        Ok(status)
    }

    /// `:packages clean`: removes every clone and lock entry init.lua no longer names. Gives back
    /// their names.
    pub fn clean(&self, specs: &[PackageSpec]) -> Result<Vec<String>, String> {
        let _busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let named: Vec<String> = specs.iter().filter_map(|s| name_of(s).ok()).collect();
        let mut removed = std::collections::BTreeSet::new();
        if let Ok(entries) = std::fs::read_dir(&self.clones) {
            for entry in entries.flatten() {
                let file = entry.file_name().to_string_lossy().into_owned();
                if named.contains(&file) || !entry.path().is_dir() {
                    continue;
                }
                remove_dir(&entry.path())?;
                // A clone left half done (`.NAME.partial`) goes too, without being listed.
                if valid_name(&file) {
                    removed.insert(file);
                }
            }
        }
        let mut lock = self.lock()?;
        let before = lock.len();
        lock.retain(|name, _| {
            let keep = named.contains(name);
            if !keep {
                removed.insert(name.clone());
            }
            keep
        });
        if lock.len() != before {
            self.write_lock(&lock)?;
        }
        Ok(removed.into_iter().collect())
    }

    // ------------------------------------------------------------------ git

    fn clone(&self, url: &str, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(&self.clones).map_err(|e| format!("can't make {}: {e}", self.clones.display()))?;
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // Into a folder of its own first, so a clone that fails half way leaves nothing behind.
        let partial = self.clones.join(format!(".{name}.partial"));
        remove_dir(&partial)?;
        let target = partial.to_string_lossy().into_owned();
        if let Err(e) = self.git.run(
            None,
            &["clone", "--quiet", "--no-recurse-submodules", "--", url, &target],
        ) {
            let _ = remove_dir(&partial);
            return Err(format!("can't fetch {url}: {e}"));
        }
        std::fs::rename(&partial, dir).map_err(|e| format!("can't move the clone into place: {e}"))
    }

    fn origin(&self, dir: &Path) -> Option<String> {
        self.git
            .run(Some(dir), &["config", "--get", "remote.origin.url"])
            .ok()
            .map(|s| s.trim().to_string())
    }

    fn head(&self, dir: &Path) -> Option<String> {
        if !dir.join(".git").exists() {
            return None;
        }
        self.rev(dir, "HEAD")
    }

    fn rev(&self, dir: &Path, name: &str) -> Option<String> {
        self.git
            .run(
                Some(dir),
                &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")],
            )
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() == 40)
    }

    /// The commit init.lua asks for, from what the clone has (no fetch).
    fn resolve(&self, dir: &Path, spec: &PackageSpec) -> Result<String, String> {
        let (refname, what) = match (&spec.tag, &spec.branch, &spec.commit) {
            (Some(t), _, _) => (format!("refs/tags/{t}"), format!("tag {t}")),
            (_, Some(b), _) => (format!("refs/remotes/origin/{b}"), format!("branch {b}")),
            (_, _, Some(c)) => (c.clone(), format!("commit {c}")),
            _ => ("refs/remotes/origin/HEAD".into(), "a default branch".into()),
        };
        self.rev(dir, &refname)
            .ok_or_else(|| format!("{} has no {what}", url_of(&spec.source).unwrap_or_default()))
    }

    /// `commit`, fetching once if the clone doesn't have it yet.
    fn have(&self, dir: &Path, commit: &str, url: &str) -> Result<String, String> {
        if let Some(c) = self.rev(dir, commit) {
            return Ok(c);
        }
        self.git
            .run(Some(dir), &["fetch", "--quiet", "--tags", "--force", "origin"])
            .map_err(|e| format!("roster.lock pins {}, which isn't fetched yet: {e}", short(commit)))?;
        self.rev(dir, commit)
            .ok_or_else(|| format!("roster.lock pins {}, which {url} doesn't have", short(commit)))
    }

    fn checkout(&self, dir: &Path, commit: &str) -> Result<(), String> {
        self.git
            .run(Some(dir), &["checkout", "--quiet", "--force", "--detach", commit])
            .map(|_| ())
    }
}

fn find<'a>(specs: &'a [PackageSpec], name: &str) -> Result<&'a PackageSpec, String> {
    specs
        .iter()
        .find(|s| name_of(s).ok().as_deref() == Some(name))
        .ok_or_else(|| format!("init.lua names no Package {name}"))
}

fn remove_dir(dir: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            // git keeps its objects read-only; Windows won't delete those as they are.
            if cfg!(windows) {
                make_writable(dir);
                if std::fs::remove_dir_all(dir).is_ok() {
                    return Ok(());
                }
            }
            Err(format!("can't remove {}: {e}", dir.display()))
        }
    }
}

fn make_writable(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            make_writable(&path);
        } else if let Ok(meta) = std::fs::metadata(&path) {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
}
