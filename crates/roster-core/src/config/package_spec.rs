//! The rules for init.lua's `packages` entries ([`PackageSpec`], ticket 24, decision Q94): which
//! sources roster fetches, what a Package is named, which `dir` stays inside its repo. init.lua's
//! check refuses a spec that breaks them, and the installer ([`crate::package`]) applies the same
//! ones, so they live with the spec rather than with either user.

use super::PackageSpec;
use std::collections::BTreeMap;

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

/// A usable Package name: its clone's folder and its key in `roster.lock`.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 100
        && !n.starts_with(['.', '-'])
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}
