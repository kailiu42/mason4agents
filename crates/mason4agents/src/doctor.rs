use crate::installers::manager::{command_exists, manager_for_source_type, package_manager_types};
use crate::paths::MasonPaths;
use crate::registry::load_cached_registry;
use crate::types::Result;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorReport {
    pub ok: bool,
    pub paths: PathDiagnostics,
    pub path_env: PathEnvDiagnostic,
    pub registry: RegistryDiagnostic,
    pub managers: Vec<ManagerDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PathDiagnostics {
    pub config_dir: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub state_dir: String,
    pub bin_dir: String,
    pub bin_dir_exists: bool,
    pub data_dir_writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PathEnvDiagnostic {
    pub contains_bin_dir: bool,
    pub bin_dir_first: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegistryDiagnostic {
    pub cache_present: bool,
    pub package_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagerDiagnostic {
    pub source_type: String,
    pub manager: String,
    pub available: bool,
}

pub fn doctor(paths: &MasonPaths) -> Result<DoctorReport> {
    let _ = paths.ensure_base_dirs();
    let registry = match load_cached_registry(paths) {
        Ok(cache) => RegistryDiagnostic {
            cache_present: true,
            package_count: cache.packages.len(),
            error: None,
        },
        Err(err) => RegistryDiagnostic {
            cache_present: false,
            package_count: 0,
            error: Some(err.to_string()),
        },
    };
    let path_env = inspect_path_env(&paths.bin_dir);
    let managers = package_manager_types()
        .iter()
        .map(|ty| {
            let manager = manager_for_source_type(ty).expect("known package manager type");
            let available = if *ty == "pypi" {
                command_exists("python3") || command_exists("python")
            } else {
                command_exists(manager)
            };
            ManagerDiagnostic {
                source_type: (*ty).to_owned(),
                manager: manager.to_owned(),
                available,
            }
        })
        .collect::<Vec<_>>();
    let paths_diag = PathDiagnostics {
        config_dir: paths.config_dir.display().to_string(),
        data_dir: paths.data_dir.display().to_string(),
        cache_dir: paths.cache_dir.display().to_string(),
        state_dir: paths.state_dir.display().to_string(),
        bin_dir: paths.bin_dir.display().to_string(),
        bin_dir_exists: paths.bin_dir.is_dir(),
        data_dir_writable: writable(&paths.data_dir),
    };
    let ok = paths_diag.bin_dir_exists && paths_diag.data_dir_writable && registry.cache_present;
    Ok(DoctorReport {
        ok,
        paths: paths_diag,
        path_env,
        registry,
        managers,
    })
}

fn inspect_path_env(bin_dir: &Path) -> PathEnvDiagnostic {
    let Some(path) = env::var_os("PATH") else {
        return PathEnvDiagnostic {
            contains_bin_dir: false,
            bin_dir_first: false,
        };
    };
    let parts = env::split_paths(&path).collect::<Vec<_>>();
    PathEnvDiagnostic {
        contains_bin_dir: parts.iter().any(|p| p == bin_dir),
        bin_dir_first: parts.first().map(|p| p == bin_dir).unwrap_or(false),
    }
}

fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let file = dir.join(format!(".write-test-{}", std::process::id()));
    match OpenOptions::new().create_new(true).write(true).open(&file) {
        Ok(_) => {
            let _ = fs::remove_file(file);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use std::collections::HashMap;
    use std::ffi::OsString;

    #[test]
    fn reports_paths_managers_and_missing_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(tmp.path()));
        env.insert(
            "MASON4AGENTS_DATA_HOME".to_owned(),
            OsString::from(tmp.path().join("data")),
        );
        env.insert(
            "MASON4AGENTS_CACHE_HOME".to_owned(),
            OsString::from(tmp.path().join("cache")),
        );
        let paths = MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap();
        let report = doctor(&paths).unwrap();
        assert!(report.paths.bin_dir_exists);
        assert!(report.paths.data_dir_writable);
        assert!(!report.registry.cache_present);
        assert!(report.managers.iter().any(|m| m.source_type == "npm"));
    }
}
