use crate::paths::MasonPaths;
use crate::types::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;

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
        let parent = paths.state_file.parent().expect("state file parent");
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!("installed.json.tmp-{}", std::process::id()));
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(tmp, &paths.state_file)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use std::collections::HashMap;
    use std::ffi::OsString;

    #[test]
    fn state_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(tmp.path()));
        env.insert(
            "MASON4AGENTS_DATA_HOME".to_owned(),
            OsString::from(tmp.path().join("data")),
        );
        let paths = MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap();
        paths.ensure_base_dirs().unwrap();
        let mut state = InstalledState::default();
        state.packages.insert(
            "tool".to_owned(),
            InstalledPackage {
                name: "tool".to_owned(),
                version: "1.0.0".to_owned(),
                source_id: "pkg:generic/acme/tool@1.0.0".to_owned(),
                bins: BTreeMap::from([("tool".to_owned(), "bin/tool".to_owned())]),
                share: BTreeMap::new(),
                opt: BTreeMap::new(),
                installed_at: Utc::now(),
            },
        );
        state.save(&paths).unwrap();
        assert_eq!(InstalledState::load(&paths).unwrap().packages.len(), 1);
    }
}
