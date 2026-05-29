use crate::paths::MasonPaths;
use crate::types::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
static STATE_SAVE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct InstalledState {
    #[serde(default)]
    pub packages: BTreeMap<String, InstalledPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    pub source_id: String,
    #[serde(default)]
    pub bins: BTreeMap<String, String>,
    #[serde(default)]
    pub share: BTreeMap<String, String>,
    #[serde(default)]
    pub opt: BTreeMap<String, String>,
    pub installed_at: DateTime<Utc>,
}

impl InstalledState {
    pub fn load(paths: &MasonPaths) -> Result<Self> {
        if !paths.state_file.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(&paths.state_file)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn save(&self, paths: &MasonPaths) -> Result<()> {
        #[cfg(test)]
        if should_fail_state_save_for_test(&paths.state_file) {
            return Err(crate::types::msg("injected state save failure"));
        }

        let parent = paths.state_file.parent().expect("state file parent");
        fs::create_dir_all(parent)?;
        let bytes = serde_json::to_vec_pretty(self)?;
        write_atomically(parent, &paths.state_file, &bytes)
    }
}

fn write_atomically(parent: &Path, dest: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = write_temp_file(parent, bytes)?;
    if let Err(err) = replace_file(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn write_temp_file(parent: &Path, bytes: &[u8]) -> Result<PathBuf> {
    for _ in 0..100 {
        let counter = STATE_SAVE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(
            ".installed.json.tmp-{}-{counter}",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(mut file) => {
                if let Err(err) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&tmp);
                    return Err(err.into());
                }
                return Ok(tmp);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(crate::types::msg("could not create unique state temp file"))
}

#[cfg(windows)]
fn replace_file(tmp: &Path, dest: &Path) -> Result<()> {
    let backup = backup_existing_file(dest)?;
    if let Err(err) = fs::rename(tmp, dest) {
        if let Some(backup) = backup {
            let _ = fs::rename(&backup, dest);
        }
        return Err(err.into());
    }
    if let Some(backup) = backup {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(windows)]
fn backup_existing_file(dest: &Path) -> Result<Option<PathBuf>> {
    if !dest.exists() {
        return Ok(None);
    }
    let parent = dest.parent().expect("state file parent");
    let filename = dest
        .file_name()
        .ok_or_else(|| {
            crate::types::msg(format!("state path has no filename: {}", dest.display()))
        })?
        .to_string_lossy();
    for _ in 0..100 {
        let counter = STATE_SAVE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let backup = parent.join(format!(".{filename}.bak-{}-{counter}", std::process::id()));
        if backup.exists() {
            continue;
        }
        match fs::rename(dest, &backup) {
            Ok(()) => return Ok(Some(backup)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(crate::types::msg(
        "could not create unique state backup file",
    ))
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, dest: &Path) -> Result<()> {
    Ok(fs::rename(tmp, dest)?)
}

#[cfg(test)]
static FAIL_STATE_SAVE_PATHS: std::sync::OnceLock<std::sync::Mutex<Vec<PathBuf>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn should_fail_state_save_for_test(path: &Path) -> bool {
    let paths = FAIL_STATE_SAVE_PATHS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let mut paths = paths.lock().expect("state save failure lock");
    if let Some(index) = paths.iter().position(|candidate| candidate == path) {
        paths.remove(index);
        return true;
    }
    false
}

#[cfg(test)]
pub(crate) fn fail_next_state_save_for_test(path: &Path) {
    FAIL_STATE_SAVE_PATHS
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
        .expect("state save failure lock")
        .push(path.to_path_buf());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use std::collections::HashMap;
    use std::ffi::OsString;

    fn test_paths(root: &Path) -> MasonPaths {
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(root));
        env.insert(
            "MASON4AGENTS_DATA_HOME".to_owned(),
            OsString::from(root.join("data")),
        );
        MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap()
    }

    fn state_with_package(name: &str, version: &str) -> InstalledState {
        let mut state = InstalledState::default();
        state.packages.insert(
            name.to_owned(),
            InstalledPackage {
                name: name.to_owned(),
                version: version.to_owned(),
                source_id: format!("pkg:generic/acme/{name}@{version}"),
                bins: BTreeMap::from([(name.to_owned(), format!("bin/{name}"))]),
                share: BTreeMap::new(),
                opt: BTreeMap::new(),
                installed_at: Utc::now(),
            },
        );
        state
    }

    #[test]
    fn state_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        state_with_package("tool", "1.0.0").save(&paths).unwrap();
        assert_eq!(InstalledState::load(&paths).unwrap().packages.len(), 1);
    }

    #[test]
    fn state_save_replaces_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();

        state_with_package("tool", "1.0.0").save(&paths).unwrap();
        state_with_package("tool", "2.0.0").save(&paths).unwrap();

        let loaded = InstalledState::load(&paths).unwrap();
        assert_eq!(loaded.packages.get("tool").unwrap().version, "2.0.0");
    }

    #[test]
    fn state_save_ignores_stale_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let parent = paths.state_file.parent().unwrap();
        fs::write(
            parent.join(format!("installed.json.tmp-{}", std::process::id())),
            b"stale",
        )
        .unwrap();

        state_with_package("tool", "1.0.0").save(&paths).unwrap();

        assert_eq!(InstalledState::load(&paths).unwrap().packages.len(), 1);
    }
}
