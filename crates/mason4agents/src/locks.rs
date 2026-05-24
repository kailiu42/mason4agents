use crate::paths::MasonPaths;
use crate::types::Result;
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};

pub struct PackageLock {
    file: File,
}

impl PackageLock {
    pub fn acquire(paths: &MasonPaths, package: &str) -> Result<Self> {
        let file = open_lock_file(paths, package)?;
        file.lock_exclusive()?;
        Ok(Self { file })
    }

    pub fn try_acquire(paths: &MasonPaths, package: &str) -> Result<Option<Self>> {
        let file = open_lock_file(paths, package)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { file })),
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(err) => Err(err.into()),
        }
    }
}

impl Drop for PackageLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn open_lock_file(paths: &MasonPaths, package: &str) -> Result<File> {
    fs::create_dir_all(&paths.locks_dir)?;
    let safe = package.replace(['/', '\\', ':'], "_");
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.locks_dir.join(format!("{safe}.lock")))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use std::collections::HashMap;
    use std::ffi::OsString;

    fn test_paths() -> MasonPaths {
        let tmp = tempfile::tempdir().unwrap().keep();
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(&tmp));
        env.insert(
            "MASON4AGENTS_STATE_HOME".to_owned(),
            OsString::from(tmp.join("state")),
        );
        MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap()
    }

    #[test]
    fn same_package_is_mutually_exclusive() {
        let paths = test_paths();
        let _first = PackageLock::try_acquire(&paths, "tool").unwrap().unwrap();
        assert!(PackageLock::try_acquire(&paths, "tool").unwrap().is_none());
    }

    #[test]
    fn different_packages_can_lock_concurrently() {
        let paths = test_paths();
        let _a = PackageLock::try_acquire(&paths, "a").unwrap().unwrap();
        let _b = PackageLock::try_acquire(&paths, "b").unwrap().unwrap();
    }
}
