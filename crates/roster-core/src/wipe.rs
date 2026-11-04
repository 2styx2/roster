//! Overwriting the memory a secret passed through (best effort). A password typed in the app, or
//! the one `session.fill` brings back from serve, crosses the core inside a JSON request or
//! answer; these overwrite those buffers with zeros before they're freed, so a freed copy doesn't
//! sit in the heap until something else happens to reuse it. What the core can't reach isn't
//! wiped: the IPC buffers of the webview and Tauri, serde_json's own scratch space while parsing,
//! and the pipe's read buffer.

use serde_json::Value;
use std::io::Write;
use std::sync::atomic::{Ordering, compiler_fence};

/// Overwrite `bytes` with zeros, in a way the compiler can't leave out.
pub fn wipe_bytes(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        // SAFETY: a valid, aligned, exclusive pointer into the slice.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// Overwrite every string in `value` (not the object keys: those are names, never secrets).
pub fn wipe_value(value: &mut Value) {
    match value {
        // SAFETY: zeros are valid UTF-8, so the String stays a valid String.
        Value::String(s) => wipe_bytes(unsafe { s.as_mut_vec() }),
        Value::Array(items) => items.iter_mut().for_each(wipe_value),
        Value::Object(fields) => fields.values_mut().for_each(wipe_value),
        _ => {}
    }
}

/// A byte buffer that's overwritten when it's dropped or cleared, and that never leaves an
/// unwiped copy behind when it grows (a `Vec` that reallocates frees the old buffer as it was).
pub struct Wiped(Vec<u8>);

impl Wiped {
    pub fn with_capacity(capacity: usize) -> Self {
        Wiped(Vec::with_capacity(capacity))
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Wipe what it holds and empty it, keeping its capacity for the next use.
    pub fn clear(&mut self) {
        wipe_bytes(&mut self.0);
        self.0.clear();
    }

    pub fn extend(&mut self, bytes: &[u8]) {
        let needed = self.0.len() + bytes.len();
        if needed > self.0.capacity() {
            let mut bigger = Vec::with_capacity(needed.max(self.0.capacity() * 2));
            bigger.extend_from_slice(&self.0);
            wipe_bytes(&mut self.0);
            self.0 = bigger;
        }
        self.0.extend_from_slice(bytes);
    }
}

impl Write for Wiped {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.extend(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for Wiped {
    fn drop(&mut self) {
        wipe_bytes(&mut self.0);
    }
}

impl std::fmt::Debug for Wiped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Wiped({} bytes)", self.0.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wipe_value_zeroes_every_string_and_keeps_the_shape() {
        let mut v = json!({ "password": "hunter2", "list": ["ab", 3], "n": 1 });
        wipe_value(&mut v);
        assert_eq!(v, json!({ "password": "\0\0\0\0\0\0\0", "list": ["\0\0", 3], "n": 1 }));
    }

    #[test]
    fn wiped_grows_keeps_its_bytes_and_clears_to_empty() {
        let mut w = Wiped::with_capacity(2);
        w.write_all(b"hunter").unwrap();
        w.write_all(b"2\n").unwrap();
        assert_eq!(w.as_slice(), b"hunter2\n");
        w.clear();
        assert!(w.is_empty());
        w.write_all(b"ok").unwrap();
        assert_eq!(w.as_slice(), b"ok");
    }
}
