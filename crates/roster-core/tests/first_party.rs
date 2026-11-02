//! First-party Plugins (decision Q94): every folder in the repo's `plugins/` is checked here, in
//! the same `cargo test` run as the core. Each one is installed the way a user installs it, as a
//! Package with `dir = "plugins/NAME"` from a git repo (a local bare repo made from this checkout,
//! so nothing touches the network), then loaded through the Plugin host the Tauri shell uses with
//! the permissions it asks for. A Plugin's own behaviour is tested in its own file next to this one
//! (`plugin_NAME.rs`) and in `app/src/plugins/`; see `plugins/README.md`. With no Plugins in the
//! folder yet, there's nothing to install and the test passes.

mod common;

use roster_core::config::PackageSpec;
use roster_core::package::Packages;
use roster_core::plugin::{Limits, PluginHost, Serve, Source, read_manifest};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
}

/// The first-party Plugins: each folder in `plugins/`.
fn first_party() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(plugins_dir())
        .expect("the repo has a plugins/ folder")
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn temp(test: &str) -> common::Temp {
    common::temp(&format!("first-party-{test}"))
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

struct NoServe;
impl Serve for NoServe {
    fn call(&self, method: &str, _: Value) -> Result<Value, String> {
        Err(format!("no {method} in this test"))
    }
}

#[test]
fn the_plugins_folder_says_how_to_install_test_and_review_a_first_party_plugin() {
    let readme = std::fs::read_to_string(plugins_dir().join("README.md")).expect("plugins/README.md");
    for needed in [
        "\"https://github.com/2styx2/roster\", dir = \"plugins/",
        "roster.lock",
        "## Tested in CI",
        "## Security review",
    ] {
        assert!(readme.contains(needed), "plugins/README.md has no {needed:?}");
    }
}

#[test]
fn every_first_party_plugin_installs_as_a_package_from_its_folder_and_loads() {
    let names = first_party();
    if names.is_empty() {
        return;
    }
    // roster's repo as a user's git would see it: the plugins/ folder, committed and pushed.
    let root = temp("install");
    let (bare, work) = (root.join("remote/roster.git"), root.join("work"));
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
    copy_dir(&plugins_dir(), &work.join("plugins"));
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    git(&work, &["add", "."]);
    git(&work, &["commit", "--quiet", "-m", "first-party Plugins"]);
    git(&work, &["push", "--quiet", bare.to_str().unwrap(), "main"]);

    let specs: Vec<PackageSpec> = names
        .iter()
        .map(|name| PackageSpec {
            source: bare.to_str().unwrap().into(),
            name: None,
            tag: None,
            branch: None,
            commit: None,
            dir: Some(format!("plugins/{name}")),
            config: Default::default(),
        })
        .collect();
    let packages = Packages::new(&root.join("data"), &root.join("config"));
    for status in packages.sync(&specs) {
        assert_eq!(status.error, None, "{}", status.name);
    }
    for name in &names {
        let (dir, config) = packages.loadable(&specs, name).unwrap();
        let manifest = read_manifest(&dir).unwrap_or_else(|e| panic!("plugins/{name}: {e}"));
        assert_eq!(
            &manifest.name, name,
            "plugins/{name}: the manifest's name is its folder's"
        );
        let host = PluginHost::new(Arc::new(NoServe), Limits::default());
        let (_, reply) = host
            .load_with(&Source::Dir(dir), &manifest.permissions, &config)
            .unwrap_or_else(|e| panic!("plugins/{name}: {e}"));
        assert!(reply.error.is_none(), "plugins/{name}: {:?}", reply.error);
        packages.pin(&specs, name).unwrap();
    }
}
