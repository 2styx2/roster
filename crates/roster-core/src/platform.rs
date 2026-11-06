//! Facts about the machine the app runs on.

/// The OS the app runs on: which Backends there can be (detect.rs), `roster.os` in Lua, where
/// the Config lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Linux,
    Macos,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        }
    }

    /// `roster.os` in Lua.
    pub fn as_str(self) -> &'static str {
        match self {
            Os::Windows => "windows",
            Os::Linux => "linux",
            Os::Macos => "macos",
        }
    }
}

/// The Windows build number (e.g. 26200 for 10.0.26200), for xterm's `windowsPty` option: ConPTY
/// sits between the terminal and the shell on Windows, and how it reflows depends on the build.
/// `None` off Windows.
pub fn windows_build() -> Option<u32> {
    #[cfg(windows)]
    {
        win::build()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
mod win {
    /// OSVERSIONINFOW. `RtlGetVersion` reports the real version, unlike `GetVersionEx`, which
    /// answers what the exe's manifest claims to support.
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd: [u16; 128],
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }

    pub fn build() -> Option<u32> {
        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            csd: [0; 128],
        };
        // SAFETY: `info` is a properly sized OSVERSIONINFOW with its size field set.
        let status = unsafe { RtlGetVersion(&mut info) };
        (status == 0 && info.build > 0).then_some(info.build)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(not(windows))]
    fn off_windows_there_is_no_build() {
        assert_eq!(super::windows_build(), None);
    }
}
