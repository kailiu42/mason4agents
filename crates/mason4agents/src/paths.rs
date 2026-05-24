use crate::types::{msg, Result};
use serde::Serialize;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MasonPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub state_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub packages_dir: PathBuf,
    pub share_dir: PathBuf,
    pub opt_dir: PathBuf,
    pub state_file: PathBuf,
    pub locks_dir: PathBuf,
    pub registry_dir: PathBuf,
    pub downloads_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl MasonPaths {
    pub fn from_env() -> Result<Self> {
        #[cfg(windows)]
        {
            if env::var_os("HOME").is_none() {
                if let Some(up) = env::var_os("USERPROFILE") {
                    env::set_var("HOME", up);
                }
            }
            if env::var_os("XDG_CONFIG_HOME").is_none() {
                if let Some(appdata) = env::var_os("APPDATA") {
                    env::set_var("XDG_CONFIG_HOME", appdata);
                }
            }
            if env::var_os("XDG_DATA_HOME").is_none() {
                if let Some(localappdata) = env::var_os("LOCALAPPDATA") {
                    env::set_var("XDG_DATA_HOME", localappdata);
                }
            }
            if env::var_os("XDG_CACHE_HOME").is_none() {
                if let Some(localappdata) = env::var_os("LOCALAPPDATA") {
                    env::set_var("XDG_CACHE_HOME", localappdata);
                }
            }
            if env::var_os("XDG_STATE_HOME").is_none() {
                if let Some(localappdata) = env::var_os("LOCALAPPDATA") {
                    env::set_var("XDG_STATE_HOME", localappdata);
                }
            }
        }
        Self::from_getter(|key| env::var_os(key))
    }

    pub fn from_getter<F>(mut get: F) -> Result<Self>
    where
        F: FnMut(&str) -> Option<OsString>,
    {
        let home = get("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| msg("HOME is required to resolve mason4agents directories"))?;
        let config_base = env_or_xdg(
            &mut get,
            "MASON4AGENTS_CONFIG_HOME",
            "XDG_CONFIG_HOME",
            &home,
            ".config",
        );
        let data_base = env_or_xdg(
            &mut get,
            "MASON4AGENTS_DATA_HOME",
            "XDG_DATA_HOME",
            &home,
            ".local/share",
        );
        let cache_base = env_or_xdg(
            &mut get,
            "MASON4AGENTS_CACHE_HOME",
            "XDG_CACHE_HOME",
            &home,
            ".cache",
        );
        let state_base = env_or_xdg(
            &mut get,
            "MASON4AGENTS_STATE_HOME",
            "XDG_STATE_HOME",
            &home,
            ".local/state",
        );

        let config_dir = config_base.join("mason4agents");
        let data_dir = data_base.join("mason4agents");
        let cache_dir = cache_base.join("mason4agents");
        let state_dir = state_base.join("mason4agents");
        Ok(Self {
            bin_dir: data_dir.join("bin"),
            packages_dir: data_dir.join("packages"),
            share_dir: data_dir.join("share"),
            opt_dir: data_dir.join("opt"),
            state_file: state_dir.join("installed.json"),
            locks_dir: state_dir.join("locks"),
            registry_dir: cache_dir.join("registry"),
            downloads_dir: cache_dir.join("downloads"),
            logs_dir: cache_dir.join("logs"),
            config_dir,
            data_dir,
            cache_dir,
            state_dir,
        })
    }

    pub fn ensure_base_dirs(&self) -> Result<()> {
        for dir in [
            &self.config_dir,
            &self.data_dir,
            &self.cache_dir,
            &self.state_dir,
            &self.bin_dir,
            &self.packages_dir,
            &self.share_dir,
            &self.opt_dir,
            &self.locks_dir,
            &self.registry_dir,
            &self.downloads_dir,
            &self.logs_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn registry_index_file(&self) -> PathBuf {
        self.registry_dir.join("index.json")
    }

    pub fn registry_checksum_file(&self) -> PathBuf {
        self.registry_dir.join("index.sha256")
    }

    pub fn package_dir(&self, name: &str) -> PathBuf {
        self.packages_dir.join(name)
    }

    pub fn package_tmp_dir(&self, name: &str) -> PathBuf {
        self.packages_dir
            .join(format!(".tmp-{name}-{}", std::process::id()))
    }

    pub fn package_old_dir(&self, name: &str) -> PathBuf {
        self.packages_dir
            .join(format!(".old-{name}-{}", std::process::id()))
    }
}

fn env_or_xdg<F>(get: &mut F, explicit: &str, xdg: &str, home: &Path, fallback: &str) -> PathBuf
where
    F: FnMut(&str) -> Option<OsString>,
{
    if let Some(path) = get(explicit) {
        let p = PathBuf::from(path);
        if p.is_relative() {
            return home.join(fallback);
        }
        return p;
    }
    if let Some(path) = get(xdg) {
        let p = PathBuf::from(path);
        if p.is_relative() {
            return home.join(fallback);
        }
        return p;
    }
    home.join(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn paths(env: &[(&str, &str)]) -> MasonPaths {
        let map: HashMap<String, OsString> = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), OsString::from(v)))
            .collect();
        MasonPaths::from_getter(|key| map.get(key).cloned()).unwrap()
    }

    #[test]
    fn resolves_xdg_paths() {
        let p = paths(&[
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/cfg"),
            ("XDG_DATA_HOME", "/data"),
            ("XDG_CACHE_HOME", "/cache"),
            ("XDG_STATE_HOME", "/state"),
        ]);
        assert_eq!(p.config_dir, PathBuf::from("/cfg/mason4agents"));
        assert_eq!(p.data_dir, PathBuf::from("/data/mason4agents"));
        assert_eq!(p.cache_dir, PathBuf::from("/cache/mason4agents"));
        assert_eq!(p.state_dir, PathBuf::from("/state/mason4agents"));
        assert_eq!(p.bin_dir, PathBuf::from("/data/mason4agents/bin"));
    }

    #[test]
    fn explicit_overrides_win_over_xdg() {
        let p = paths(&[
            ("HOME", "/home/u"),
            ("XDG_DATA_HOME", "/xdg-data"),
            ("MASON4AGENTS_DATA_HOME", "/override-data"),
            ("MASON4AGENTS_CACHE_HOME", "/override-cache"),
            ("MASON4AGENTS_CONFIG_HOME", "/override-config"),
            ("MASON4AGENTS_STATE_HOME", "/override-state"),
        ]);
        assert_eq!(p.data_dir, PathBuf::from("/override-data/mason4agents"));
        assert_eq!(p.cache_dir, PathBuf::from("/override-cache/mason4agents"));
        assert_eq!(p.config_dir, PathBuf::from("/override-config/mason4agents"));
        assert_eq!(p.state_dir, PathBuf::from("/override-state/mason4agents"));
    }

    #[test]
    fn uses_home_fallbacks() {
        let p = paths(&[("HOME", "/home/u")]);
        assert_eq!(p.config_dir, PathBuf::from("/home/u/.config/mason4agents"));
        assert_eq!(
            p.data_dir,
            PathBuf::from("/home/u/.local/share/mason4agents")
        );
        assert_eq!(p.cache_dir, PathBuf::from("/home/u/.cache/mason4agents"));
        assert_eq!(
            p.state_dir,
            PathBuf::from("/home/u/.local/state/mason4agents")
        );
    }
}
