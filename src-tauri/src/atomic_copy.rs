//! Streams bytes into a file that appears under its name only once it is complete.
//!
//! Standard library only, so the tests run without building the app:
//! `rustc --edition 2021 --test src-tauri/src/atomic_copy.rs -o /tmp/atomic_copy && /tmp/atomic_copy`

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// The file a copy is written to until it is complete. Its extension is no archive's, so a scan
/// of the folder never reads one, and the next copy to the same destination replaces it.
fn partial_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// Copies `input` to `destination`, replacing what is there only if every byte arrived. Stopped
/// midway, by an error or by the process dying, it leaves whatever was at `destination` as it was:
/// a truncated archive under its real name would fail every later scan of the library.
pub fn copy_atomically(input: &mut impl Read, destination: &Path) -> io::Result<u64> {
    let partial = partial_path(destination);
    let copied = (|| {
        let mut output = File::create(&partial)?;
        let copied = io::copy(input, &mut output)?;
        output.sync_all()?;
        Ok(copied)
    })();
    match copied.and_then(|bytes| fs::rename(&partial, destination).map(|()| bytes)) {
        Ok(bytes) => Ok(bytes),
        Err(err) => {
            let _ = fs::remove_file(&partial);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error, ErrorKind};
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A folder of its own for one test, removed when it ends.
    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("atomic-copy-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Folder(dir)
        }
        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(&self.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            names.sort();
            names
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Hands out some bytes, then fails, as a provider does when its connection drops.
    struct FailsAfter(usize);
    impl Read for FailsAfter {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.0 == 0 {
                return Err(Error::new(ErrorKind::ConnectionReset, "provider went away"));
            }
            let n = self.0.min(buf.len());
            buf[..n].fill(7);
            self.0 -= n;
            Ok(n)
        }
    }

    #[test]
    fn a_complete_copy_is_the_only_thing_left() {
        let folder = Folder::new();
        let dest = folder.0.join("v01.cbz");
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(copy_atomically(&mut Cursor::new(&bytes), &dest).unwrap(), bytes.len() as u64);
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert_eq!(folder.names(), ["v01.cbz"]);
    }

    #[test]
    fn a_failed_copy_leaves_nothing_behind() {
        let folder = Folder::new();
        let dest = folder.0.join("v01.cbz");
        let err = copy_atomically(&mut FailsAfter(100_000), &dest).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::ConnectionReset);
        assert!(folder.names().is_empty(), "left {:?}", folder.names());
    }

    #[test]
    fn a_failed_copy_keeps_the_file_it_would_have_replaced() {
        let folder = Folder::new();
        let dest = folder.0.join("v01.cbz");
        fs::write(&dest, b"the good copy").unwrap();
        copy_atomically(&mut FailsAfter(100_000), &dest).unwrap_err();
        assert_eq!(fs::read(&dest).unwrap(), b"the good copy");
        assert_eq!(folder.names(), ["v01.cbz"]);
    }

    #[test]
    fn a_complete_copy_replaces_the_old_file() {
        let folder = Folder::new();
        let dest = folder.0.join("v01.cbz");
        fs::write(&dest, b"what an earlier failed import left").unwrap();
        copy_atomically(&mut Cursor::new(b"new"), &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn a_partial_file_from_a_dead_process_is_replaced() {
        let folder = Folder::new();
        let dest = folder.0.join("v01.cbz");
        fs::write(folder.0.join("v01.cbz.part"), vec![1u8; 1000]).unwrap();
        copy_atomically(&mut Cursor::new(b"whole"), &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"whole");
        assert_eq!(folder.names(), ["v01.cbz"]);
    }

    #[test]
    fn a_missing_folder_is_an_error_not_a_panic() {
        let folder = Folder::new();
        let dest = folder.0.join("no-such-folder").join("v01.cbz");
        assert_eq!(copy_atomically(&mut Cursor::new(b"x"), &dest).unwrap_err().kind(), ErrorKind::NotFound);
    }
}
