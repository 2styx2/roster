//! The one test seam: run the built `roster` binary as a process.
//!
//! Each `Sandbox` is a fresh temporary HOME (also the working directory) with
//! `tests/fakes` first on PATH. Fixtures are made up; never copy a real
//! Inventory here.
#![allow(dead_code)] // each test file uses a different part of the harness

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Sandbox {
    pub home: PathBuf,
    pub env: Vec<(String, String)>,
}

pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Sandbox {
    /// A new empty HOME; `name` must be unique per test.
    pub fn new(name: &str) -> Sandbox {
        let home = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        Sandbox {
            home,
            env: Vec::new(),
        }
    }

    /// Write `content` to `rel` under HOME, creating parent directories.
    pub fn write(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    pub fn set_env(&mut self, key: &str, value: &str) {
        self.env.push((key.into(), value.into()));
    }

    /// Run `roster ARGS` with HOME and the working directory set to the sandbox.
    pub fn roster(&self, args: &[&str]) -> Out {
        let fakes = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fakes");
        let out = Command::new(env!("CARGO_BIN_EXE_roster"))
            .args(args)
            .current_dir(&self.home)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", format!("{}:/usr/bin:/bin", fakes.display()))
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .output()
            .unwrap();
        Out {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8(out.stdout).unwrap(),
            stderr: String::from_utf8(out.stderr).unwrap(),
        }
    }
}
