use crate::archive::{split_archive_spec, unpack_or_copy};
use crate::download::{download_to_cache_with_progress, local_path};
use crate::installers::{build, generic, github, manager, openvsx};
use crate::linker::{cleanup_package_links, create_package_links};
use crate::locks::PackageLock;
use crate::package_spec::NormalizedPackage;
use crate::paths::MasonPaths;
use crate::platform::Platform;
use crate::progress::{emit_error, NoProgressSink, ProgressSink, ProgressStatus};
use crate::registry::{load_or_refresh_with_progress, normalize_package};
use crate::store::{InstalledPackage, InstalledState};
use crate::types::{msg, M4aError, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const STATE_LOCK: &str = "_state";

fn acquire_state_lock(paths: &MasonPaths) -> Result<PackageLock> {
    PackageLock::acquire(paths, STATE_LOCK)
}

fn select_executable_path(bin_dir: &Path, executable: &str, windows: bool) -> Option<PathBuf> {
    let bare_path = bin_dir.join(executable);
    if bare_path.exists() {
        return Some(bare_path);
    }
    if windows {
        let wrapper_path = bin_dir.join(format!("{executable}.cmd"));
        if wrapper_path.exists() {
            return Some(wrapper_path);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallResult {
    pub package: String,
    pub version: String,
    pub source_id: String,
    pub bins: BTreeMap<String, String>,
    pub package_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UninstallResult {
    pub package: String,
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WhichResult {
    pub executable: String,
    pub path: Option<PathBuf>,
    pub package: Option<String>,
}

pub struct Installer {
    paths: MasonPaths,
    platform: Platform,
}

impl Installer {
    pub fn new(paths: MasonPaths, platform: Platform) -> Self {
        Self { paths, platform }
    }

    pub fn install_requests(
        &self,
        requests: &[String],
        registry_source: Option<&str>,
        allow_build_scripts: bool,
    ) -> Result<Vec<InstallResult>> {
        let progress = NoProgressSink;
        self.install_requests_with_progress(
            requests,
            registry_source,
            allow_build_scripts,
            &progress,
        )
    }

    pub fn install_requests_with_progress(
        &self,
        requests: &[String],
        registry_source: Option<&str>,
        allow_build_scripts: bool,
        progress: &dyn ProgressSink,
    ) -> Result<Vec<InstallResult>> {
        self.install_requests_for_operation(
            "install",
            requests,
            registry_source,
            allow_build_scripts,
            false,
            progress,
        )
    }

    fn install_requests_for_operation(
        &self,
        operation: &str,
        requests: &[String],
        registry_source: Option<&str>,
        allow_build_scripts: bool,
        skip_missing_installed: bool,
        progress: &dyn ProgressSink,
    ) -> Result<Vec<InstallResult>> {
        let result = (|| -> Result<Vec<InstallResult>> {
            progress.event(
                operation,
                "request",
                ProgressStatus::Started,
                None,
                "preparing package requests",
            );
            self.paths.ensure_base_dirs()?;
            let cache = load_or_refresh_with_progress(&self.paths, registry_source, progress)?;
            let mut out = Vec::new();
            for request in requests {
                let (name, version) = parse_package_request(request);
                if skip_missing_installed {
                    let _state_lock = acquire_state_lock(&self.paths)?;
                    let state = InstalledState::load(&self.paths)?;
                    if !state.packages.contains_key(name) {
                        progress.event(
                            operation,
                            "package",
                            ProgressStatus::Succeeded,
                            Some(name),
                            "package is no longer installed; skipping update",
                        );
                        continue;
                    }
                }
                progress.event(
                    operation,
                    "resolve",
                    ProgressStatus::Running,
                    Some(name),
                    "resolving package",
                );
                let normalized =
                    normalize_package(&cache, name, version.as_deref(), &self.platform)?;
                if let Some(result) = self.install_normalized_for_request(
                    operation,
                    normalized,
                    allow_build_scripts,
                    skip_missing_installed,
                    progress,
                )? {
                    out.push(result);
                }
            }
            Ok(out)
        })();
        match &result {
            Ok(_) => progress.event(
                operation,
                "request",
                ProgressStatus::Succeeded,
                None,
                "package requests completed",
            ),
            Err(err) => emit_error(progress, operation, "request", None, err),
        }
        result
    }

    pub fn update_requests(
        &self,
        packages: &[String],
        registry_source: Option<&str>,
        allow_build_scripts: bool,
    ) -> Result<Vec<InstallResult>> {
        let progress = NoProgressSink;
        self.update_requests_with_progress(
            packages,
            registry_source,
            allow_build_scripts,
            &progress,
        )
    }

    pub fn update_requests_with_progress(
        &self,
        packages: &[String],
        registry_source: Option<&str>,
        allow_build_scripts: bool,
        progress: &dyn ProgressSink,
    ) -> Result<Vec<InstallResult>> {
        let result = (|| -> Result<Vec<InstallResult>> {
            progress.event(
                "update",
                "request",
                ProgressStatus::Started,
                None,
                "preparing update requests",
            );
            let _state_lock = acquire_state_lock(&self.paths)?;
            let state = InstalledState::load(&self.paths)?;
            let update_all = packages.is_empty();
            let requests = if update_all {
                state.packages.keys().cloned().collect::<Vec<_>>()
            } else {
                packages.to_vec()
            };
            for name in &requests {
                validate_package_name(name)?;
            }
            drop(_state_lock);
            self.install_requests_for_operation(
                "update",
                &requests,
                registry_source,
                allow_build_scripts,
                update_all,
                progress,
            )
        })();
        match &result {
            Ok(_) => progress.event(
                "update",
                "request",
                ProgressStatus::Succeeded,
                None,
                "update requests completed",
            ),
            Err(err) => emit_error(progress, "update", "request", None, err),
        }
        result
    }

    pub fn uninstall(&self, packages: &[String]) -> Result<Vec<UninstallResult>> {
        let progress = NoProgressSink;
        self.uninstall_with_progress(packages, &progress)
    }

    pub fn uninstall_with_progress(
        &self,
        packages: &[String],
        progress: &dyn ProgressSink,
    ) -> Result<Vec<UninstallResult>> {
        let result = (|| -> Result<Vec<UninstallResult>> {
            progress.event(
                "uninstall",
                "request",
                ProgressStatus::Started,
                None,
                "preparing uninstall requests",
            );
            self.paths.ensure_base_dirs()?;
            let _state_lock = acquire_state_lock(&self.paths)?;
            let mut state = InstalledState::load(&self.paths)?;
            let mut out = Vec::new();
            for package in packages {
                validate_package_name(package)?;
                let _lock = PackageLock::acquire(&self.paths, package)?;
                if let Some(installed) = state.packages.remove(package) {
                    progress.event(
                        "uninstall",
                        "remove",
                        ProgressStatus::Running,
                        Some(package),
                        "removing package links and files",
                    );
                    cleanup_package_links(&self.paths, &installed)?;
                    let dir = self.paths.package_dir(package);
                    if dir.exists() {
                        fs::remove_dir_all(dir)?;
                    }
                    progress.event(
                        "uninstall",
                        "remove",
                        ProgressStatus::Succeeded,
                        Some(package),
                        "package removed",
                    );
                    out.push(UninstallResult {
                        package: package.clone(),
                        removed: true,
                    });
                } else {
                    progress.event(
                        "uninstall",
                        "remove",
                        ProgressStatus::Skipped,
                        Some(package),
                        "package is not installed",
                    );
                    out.push(UninstallResult {
                        package: package.clone(),
                        removed: false,
                    });
                }
            }
            progress.event(
                "uninstall",
                "state",
                ProgressStatus::Running,
                None,
                "writing install state",
            );
            state.save(&self.paths)?;
            drop(_state_lock);
            Ok(out)
        })();
        match &result {
            Ok(_) => progress.event(
                "uninstall",
                "request",
                ProgressStatus::Succeeded,
                None,
                "uninstall completed",
            ),
            Err(err) => emit_error(progress, "uninstall", "request", None, err),
        }
        result
    }

    pub fn which(&self, executable: &str) -> Result<WhichResult> {
        if executable.is_empty() {
            return Err(msg("executable name must not be empty"));
        }
        if executable == "." || executable == ".." {
            return Err(msg(format!("executable name must not be '{executable}'")));
        }
        if executable.contains('/') || executable.contains('\\') {
            return Err(msg(format!(
                "executable name '{executable}' must not contain path separators"
            )));
        }
        let path =
            select_executable_path(&self.paths.bin_dir, executable, self.platform.os == "win");
        let state = InstalledState::load(&self.paths)?;
        let package = state
            .packages
            .values()
            .find(|pkg| pkg.bins.contains_key(executable))
            .map(|pkg| pkg.name.clone());
        Ok(WhichResult {
            executable: executable.to_owned(),
            path,
            package,
        })
    }

    fn install_normalized_for_request(
        &self,
        operation: &str,
        package: NormalizedPackage,
        allow_build_scripts: bool,
        skip_missing_installed: bool,
        progress: &dyn ProgressSink,
    ) -> Result<Option<InstallResult>> {
        let package_name = package.name.clone();
        progress.event(
            operation,
            "package",
            ProgressStatus::Started,
            Some(&package_name),
            "starting package install",
        );
        let result = (|| -> Result<Option<InstallResult>> {
            validate_package_name(&package.name)?;
            let name = &package.name;
            for spec in ["bins", "share", "opt"] {
                let keys: &BTreeMap<String, String> = match spec {
                    "bins" => &package.bins,
                    "share" => &package.share,
                    "opt" => &package.opt,
                    _ => unreachable!(),
                };
                for key in keys.keys() {
                    validate_package_name(key).map_err(|_| {
                        msg(format!(
                            "package '{name}' has invalid key '{key}' in '{spec}'"
                        ))
                    })?;
                }
            }
            if !package.source.build_scripts.is_empty() && !allow_build_scripts {
                return Err(M4aError::BuildScriptsDisabled {
                    package: package.name.clone(),
                    scripts: package.source.build_scripts.clone(),
                });
            }
            progress.event(
                operation,
                "lock",
                ProgressStatus::Running,
                Some(&package.name),
                "acquiring install locks",
            );
            let _state_lock = acquire_state_lock(&self.paths)?;
            let _lock = PackageLock::acquire(&self.paths, &package.name)?;
            if skip_missing_installed {
                let state = InstalledState::load(&self.paths)?;
                if !state.packages.contains_key(&package.name) {
                    progress.event(
                        operation,
                        "package",
                        ProgressStatus::Succeeded,
                        Some(&package.name),
                        "package is no longer installed; skipping update",
                    );
                    return Ok(None);
                }
            }
            let staging = self.paths.package_tmp_dir(&package.name);
            let final_dir = self.paths.package_dir(&package.name);
            let old_dir = self.paths.package_old_dir(&package.name);
            progress.event(
                operation,
                "staging",
                ProgressStatus::Running,
                Some(&package.name),
                "preparing staging directory",
            );
            remove_dir_if_exists(&staging)?;
            remove_dir_if_exists(&old_dir)?;
            fs::create_dir_all(&staging)?;
            let install_result = (|| -> Result<()> {
                progress.event(
                    operation,
                    "source",
                    ProgressStatus::Started,
                    Some(&package.name),
                    "installing package source",
                );
                install_source_with_progress(
                    &self.paths,
                    &package,
                    &staging,
                    operation,
                    allow_build_scripts,
                    progress,
                )?;
                progress.event(
                    operation,
                    "source",
                    ProgressStatus::Succeeded,
                    Some(&package.name),
                    "package source installed",
                );
                if !package.source.build_scripts.is_empty() {
                    build::run_build_scripts_with_progress(
                        &package.source.build_scripts,
                        &staging,
                        operation,
                        Some(&package.name),
                        progress,
                    )?;
                }
                Ok(())
            })();
            if let Err(err) = install_result {
                remove_dir_if_exists(&staging)?;
                return Err(err);
            }

            progress.event(
                operation,
                "commit",
                ProgressStatus::Running,
                Some(&package.name),
                "committing package directory",
            );
            if final_dir.exists() {
                fs::rename(&final_dir, &old_dir)?;
            }
            if let Err(err) = fs::rename(&staging, &final_dir) {
                if old_dir.exists() {
                    let _ = fs::rename(&old_dir, &final_dir);
                }
                return Err(err.into());
            }

            let mut state = InstalledState::load(&self.paths)?;
            // Capture previous receipt data before cleaning links, so we can
            // recreate them on rollback if link creation fails.
            let previous_receipt = state.packages.get(&package.name).cloned();
            if let Some(previous) = &previous_receipt {
                progress.event(
                    operation,
                    "link",
                    ProgressStatus::Running,
                    Some(&package.name),
                    "cleaning previous package links",
                );
                cleanup_package_links(&self.paths, previous)?;
            }
            progress.event(
                operation,
                "link",
                ProgressStatus::Running,
                Some(&package.name),
                "creating package links",
            );
            let receipt = match create_package_links(
                &self.paths,
                &package.name,
                &final_dir,
                &package.bins,
                &package.share,
                &package.opt,
            ) {
                Ok(receipt) => receipt,
                Err(err) => {
                    remove_dir_if_exists(&final_dir)?;
                    if old_dir.exists() {
                        let _ = fs::rename(&old_dir, &final_dir);
                    }
                    // Recreate previous links if we had them (rollback).
                    if let Some(previous) = &previous_receipt {
                        let prev_dir = self.paths.package_dir(&previous.name);
                        if prev_dir.exists() {
                            let _ = create_package_links(
                                &self.paths,
                                &previous.name,
                                &prev_dir,
                                &previous.bins,
                                &previous.share,
                                &previous.opt,
                            );
                        }
                    }
                    return Err(err);
                }
            };
            let installed = InstalledPackage {
                name: package.name.clone(),
                version: package.version.clone(),
                source_id: package.source.id.clone(),
                bins: receipt.bins.clone(),
                share: receipt.share,
                opt: receipt.opt,
                installed_at: Utc::now(),
            };
            progress.event(
                operation,
                "state",
                ProgressStatus::Running,
                Some(&package.name),
                "writing install state",
            );
            state
                .packages
                .insert(package.name.clone(), installed.clone());
            if let Err(err) = state.save(&self.paths) {
                if let Err(rollback_err) = rollback_committed_install(
                    &self.paths,
                    &installed,
                    previous_receipt.as_ref(),
                    &final_dir,
                    &old_dir,
                ) {
                    return Err(msg(format!(
                        "failed to save install state ({err}); rollback failed: {rollback_err}"
                    )));
                }
                return Err(err);
            }
            if old_dir.exists() {
                remove_dir_if_exists(&old_dir)?;
            }
            Ok(Some(InstallResult {
                package: package.name,
                version: package.version,
                source_id: package.source.id,
                bins: receipt.bins,
                package_dir: final_dir,
            }))
        })();
        match &result {
            Ok(Some(_)) => progress.event(
                operation,
                "package",
                ProgressStatus::Succeeded,
                Some(&package_name),
                "package installed",
            ),
            Ok(None) => {}
            Err(err) => emit_error(progress, operation, "package", Some(&package_name), err),
        }
        result
    }
}

fn parse_package_request(request: &str) -> (&str, Option<String>) {
    match request.rfind('@') {
        Some(0) | None => (request, None),
        Some(index) => (&request[..index], Some(request[index + 1..].to_owned())),
    }
}

fn install_source_with_progress(
    paths: &MasonPaths,
    package: &NormalizedPackage,
    staging: &Path,
    operation: &str,
    allow_build_scripts: bool,
    progress: &dyn ProgressSink,
) -> Result<()> {
    match package.source.source_type.as_str() {
        "github" => install_github_with_progress(paths, package, staging, operation, progress),
        "generic" => install_generic_with_progress(paths, package, staging, operation, progress),
        "openvsx" => install_openvsx_with_progress(paths, package, staging, operation, progress),
        ty if manager::manager_for_source_type(ty).is_some() => install_with_manager_with_progress(
            package,
            staging,
            operation,
            allow_build_scripts,
            progress,
        ),
        other => Err(msg(format!(
            "unsupported package source type '{other}' for {}",
            package.name
        ))),
    }
}

fn install_github_with_progress(
    paths: &MasonPaths,
    package: &NormalizedPackage,
    staging: &Path,
    operation: &str,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let asset = package.source.asset.as_ref().ok_or_else(|| {
        msg(format!(
            "github package {} has no selected asset",
            package.name
        ))
    })?;
    let file_spec = asset.file.as_deref().ok_or_else(|| {
        msg(format!(
            "github package {} selected asset has no file",
            package.name
        ))
    })?;
    let (file, strip_prefix) = split_archive_spec(file_spec);
    let locator = if local_path(file).is_some()
        || file.starts_with("file://")
        || file.starts_with("http://")
        || file.starts_with("https://")
    {
        file.to_owned()
    } else {
        github::release_asset_url(&package.source, file)?
    };
    let downloaded = download_to_cache_with_progress(
        &locator,
        &paths.downloads_dir,
        operation,
        Some(&package.name),
        progress,
    )?;
    unpack_or_copy_with_progress(
        &downloaded,
        staging,
        strip_prefix,
        operation,
        Some(&package.name),
        progress,
    )
}

fn install_generic_with_progress(
    paths: &MasonPaths,
    package: &NormalizedPackage,
    staging: &Path,
    operation: &str,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let file = package
        .source
        .asset
        .as_ref()
        .and_then(|a| a.file.as_deref());
    let locator = generic::asset_locator(&package.source, file)?;
    let (locator, strip_prefix) = split_archive_spec(&locator);
    let downloaded = download_to_cache_with_progress(
        locator,
        &paths.downloads_dir,
        operation,
        Some(&package.name),
        progress,
    )?;
    unpack_or_copy_with_progress(
        &downloaded,
        staging,
        strip_prefix,
        operation,
        Some(&package.name),
        progress,
    )
}

fn install_openvsx_with_progress(
    paths: &MasonPaths,
    package: &NormalizedPackage,
    staging: &Path,
    operation: &str,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let locator = package
        .source
        .asset
        .as_ref()
        .and_then(|a| a.file.as_deref())
        .map(str::to_owned)
        .unwrap_or(openvsx::vsix_url(&package.source)?);
    let (locator, strip_prefix) = split_archive_spec(&locator);
    let downloaded = download_to_cache_with_progress(
        locator,
        &paths.downloads_dir,
        operation,
        Some(&package.name),
        progress,
    )?;
    unpack_or_copy_with_progress(
        &downloaded,
        staging,
        strip_prefix,
        operation,
        Some(&package.name),
        progress,
    )
}

fn install_with_manager_with_progress(
    package: &NormalizedPackage,
    staging: &Path,
    operation: &str,
    allow_build_scripts: bool,
    progress: &dyn ProgressSink,
) -> Result<()> {
    progress.event(
        operation,
        "manager",
        ProgressStatus::Started,
        Some(&package.name),
        "checking external package manager",
    );
    manager::ensure_manager(&package.source.source_type)?;
    let spec = manager::build_install_command(&package.source, staging, allow_build_scripts)?;
    manager::run_install_command_with_progress(&spec, operation, Some(&package.name), progress)
}

fn unpack_or_copy_with_progress(
    path: &Path,
    dest: &Path,
    strip_prefix: Option<&str>,
    operation: &str,
    package: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<()> {
    progress.event(
        operation,
        "unpack",
        ProgressStatus::Started,
        package,
        "unpacking package source",
    );
    let result = unpack_or_copy(path, dest, strip_prefix);
    match &result {
        Ok(()) => progress.event(
            operation,
            "unpack",
            ProgressStatus::Succeeded,
            package,
            "package source unpacked",
        ),
        Err(err) => emit_error(progress, operation, "unpack", package, err),
    }
    result
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn rollback_committed_install(
    paths: &MasonPaths,
    installed: &InstalledPackage,
    previous: Option<&InstalledPackage>,
    final_dir: &Path,
    old_dir: &Path,
) -> Result<()> {
    cleanup_package_links(paths, installed)?;
    remove_dir_if_exists(final_dir)?;
    if old_dir.exists() {
        fs::rename(old_dir, final_dir)?;
    }
    if let Some(previous) = previous {
        if final_dir.exists() {
            create_package_links(
                paths,
                &previous.name,
                final_dir,
                &previous.bins,
                &previous.share,
                &previous.opt,
            )?;
        }
    }
    Ok(())
}

/// Validate that a package name does not contain path separators or special
/// path segments that could lead to directory traversal.
pub(crate) fn validate_package_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(msg("package name must not be empty"));
    }
    if name == "." || name == ".." {
        return Err(msg(format!("package name must not be '{name}'")));
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(msg(format!(
            "package name '{name}' must not contain path separators"
        )));
    }
    // Reject any path segment that is `.` or `..`
    for segment in name.split('/') {
        if segment == "." || segment == ".." {
            return Err(msg(format!(
                "package name '{name}' must not contain path segment '{segment}'"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_spec::{AssetSpec, NormalizedSource};
    use crate::registry::refresh_registry;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io::Write;
    use zip::write::FileOptions;

    fn paths(root: &Path) -> MasonPaths {
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(root));
        env.insert(
            "MASON4AGENTS_DATA_HOME".to_owned(),
            OsString::from(root.join("data")),
        );
        env.insert(
            "MASON4AGENTS_CACHE_HOME".to_owned(),
            OsString::from(root.join("cache")),
        );
        env.insert(
            "MASON4AGENTS_STATE_HOME".to_owned(),
            OsString::from(root.join("state")),
        );
        MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap()
    }

    fn write_zip_with_content(path: &Path, content: &[u8]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("pkg/bin/hello", FileOptions::<()>::default())
            .unwrap();
        zip.write_all(content).unwrap();
        zip.start_file("pkg/bin/share/hello.txt", FileOptions::<()>::default())
            .unwrap();
        zip.write_all(b"share").unwrap();
        zip.start_file("pkg/bin/opt/hello.txt", FileOptions::<()>::default())
            .unwrap();
        zip.write_all(b"opt").unwrap();
        zip.finish().unwrap();
    }

    fn write_zip(path: &Path) {
        write_zip_with_content(path, b"#!/bin/sh\necho hello\n");
    }

    #[test]
    fn select_executable_path_prefers_bare_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path();
        let bare = bin_dir.join("tool");
        let wrapper = bin_dir.join("tool.cmd");
        fs::write(&bare, b"bare").unwrap();
        fs::write(&wrapper, b"wrapper").unwrap();

        assert_eq!(select_executable_path(bin_dir, "tool", true), Some(bare));
    }

    #[test]
    fn select_executable_path_uses_windows_cmd_wrapper_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path();
        let wrapper = bin_dir.join("tool.cmd");
        fs::write(&wrapper, b"wrapper").unwrap();

        assert_eq!(select_executable_path(bin_dir, "tool", true), Some(wrapper));
    }

    #[test]
    fn select_executable_path_ignores_cmd_wrapper_off_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path();
        fs::write(bin_dir.join("tool.cmd"), b"wrapper").unwrap();

        assert_eq!(select_executable_path(bin_dir, "tool", false), None);
    }

    #[test]
    fn which_returns_windows_cmd_wrapper_when_bare_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let wrapper = paths.bin_dir.join("tool.cmd");
        fs::write(&wrapper, b"wrapper").unwrap();
        let installer = Installer::new(paths, Platform::new("win", "x64", None));

        let result = installer.which("tool").unwrap();

        assert_eq!(result.path, Some(wrapper));
        assert_eq!(result.package, None);
    }

    #[test]
    fn select_executable_path_returns_none_when_missing() {
        let tmp = tempfile::tempdir().unwrap();

        assert_eq!(select_executable_path(tmp.path(), "tool", true), None);
    }

    fn write_registry_version(root: &Path, archive: &Path, version: &str) -> PathBuf {
        let dir = root.join("registry/packages/hello");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.yaml"),
            format!(
                r#"
name: hello
description: Hello fixture
languages: [Shell]
categories: [Formatter]
source:
  id: pkg:generic/acme/hello@{version}
  asset:
    file: '{}:pkg/bin/'
bin:
  hello: hello
share:
  hello-share: share
opt:
  hello-opt: opt
"#,
                archive.display()
            ),
        )
        .unwrap();
        root.join("registry")
    }

    fn write_registry(root: &Path, archive: &Path) -> PathBuf {
        write_registry_version(root, archive, "1.0.0")
    }

    fn block_next_state_save(paths: &MasonPaths) {
        let parent = paths.state_file.parent().unwrap();
        fs::create_dir_all(parent).unwrap();
        fs::create_dir(parent.join(format!("installed.json.tmp-{}", std::process::id()))).unwrap();
    }

    #[test]
    fn installs_and_uninstalls_fixture_archive_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let archive = tmp.path().join("hello.zip");
        write_zip(&archive);
        let registry = write_registry(tmp.path(), &archive);
        refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        let installer = Installer::new(paths.clone(), Platform::new("linux", "x64", Some("gnu")));
        let installed = installer
            .install_requests(&["hello".to_owned()], None, false)
            .unwrap();
        assert_eq!(installed[0].package, "hello");
        assert!(paths.package_dir("hello").join("hello").exists());
        assert!(installer.which("hello").unwrap().path.unwrap().exists());
        let removed = installer.uninstall(&["hello".to_owned()]).unwrap();
        assert!(removed[0].removed);
        assert!(!paths.bin_dir.join("hello").exists());
        assert!(!paths.package_dir("hello").exists());
    }

    #[test]
    fn update_all_skips_stale_request_after_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let archive = tmp.path().join("hello.zip");
        write_zip(&archive);
        let registry = write_registry(tmp.path(), &archive);
        refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        let installer = Installer::new(paths.clone(), Platform::new("linux", "x64", Some("gnu")));

        installer
            .install_requests(&["hello".to_owned()], None, false)
            .unwrap();
        let stale_update_all_requests = vec!["hello".to_owned()];
        installer.uninstall(&["hello".to_owned()]).unwrap();

        let updated = installer
            .install_requests_for_operation(
                "update",
                &stale_update_all_requests,
                None,
                false,
                true,
                &NoProgressSink,
            )
            .unwrap();

        assert!(updated.is_empty());
        assert!(!InstalledState::load(&paths)
            .unwrap()
            .packages
            .contains_key("hello"));
        assert!(!paths.bin_dir.join("hello").exists());
        assert!(!paths.package_dir("hello").exists());
    }

    #[test]
    fn install_rolls_back_files_and_links_when_state_save_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let archive = tmp.path().join("hello.zip");
        write_zip(&archive);
        let registry = write_registry(tmp.path(), &archive);
        refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        block_next_state_save(&paths);
        let installer = Installer::new(paths.clone(), Platform::new("linux", "x64", Some("gnu")));

        installer
            .install_requests(&["hello".to_owned()], None, false)
            .unwrap_err();

        assert!(!InstalledState::load(&paths)
            .unwrap()
            .packages
            .contains_key("hello"));
        assert!(!paths.package_dir("hello").exists());
        assert!(!paths.bin_dir.join("hello").exists());
        assert!(!paths.share_dir.join("hello-share").exists());
        assert!(!paths.opt_dir.join("hello-opt").exists());
    }

    #[test]
    fn update_restores_previous_install_when_state_save_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let archive_v1 = tmp.path().join("hello-v1.zip");
        write_zip_with_content(&archive_v1, b"#!/bin/sh\necho v1\n");
        let registry = write_registry_version(tmp.path(), &archive_v1, "1.0.0");
        refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        let installer = Installer::new(paths.clone(), Platform::new("linux", "x64", Some("gnu")));
        installer
            .install_requests(&["hello".to_owned()], None, false)
            .unwrap();

        let archive_v2 = tmp.path().join("hello-v2.zip");
        write_zip_with_content(&archive_v2, b"#!/bin/sh\necho v2\n");
        write_registry_version(tmp.path(), &archive_v2, "2.0.0");
        refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        block_next_state_save(&paths);

        installer
            .update_requests(&["hello".to_owned()], None, false)
            .unwrap_err();

        let state = InstalledState::load(&paths).unwrap();
        assert_eq!(state.packages.get("hello").unwrap().version, "1.0.0");
        assert_eq!(
            fs::read_to_string(paths.package_dir("hello").join("hello")).unwrap(),
            "#!/bin/sh\necho v1\n"
        );
        assert!(paths.bin_dir.join("hello").exists());
        assert!(paths.share_dir.join("hello-share").exists());
        assert!(paths.opt_dir.join("hello-opt").exists());
        assert!(installer.which("hello").unwrap().path.unwrap().exists());
    }

    #[test]
    fn blocks_build_scripts_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let package = NormalizedPackage {
            name: "scripted".to_owned(),
            version: "1.0.0".to_owned(),
            description: None,
            languages: vec![],
            categories: vec![],
            deprecated: false,
            source: NormalizedSource {
                id: "pkg:generic/acme/scripted@1.0.0".to_owned(),
                source_type: "generic".to_owned(),
                namespace: Some("acme".to_owned()),
                package: "scripted".to_owned(),
                version: "1.0.0".to_owned(),
                asset: Some(AssetSpec {
                    target: None,
                    file: Some("missing.zip".to_owned()),
                    extra_files: Vec::new(),
                    bin: None,
                    extra: BTreeMap::new(),
                }),
                extra_packages: vec![],
                build_scripts: vec!["echo bad".to_owned()],
                qualifiers: BTreeMap::new(),
                subpath: None,
                build: None,
                download: None,
            },
            bins: BTreeMap::new(),
            share: BTreeMap::new(),
            opt: BTreeMap::new(),
            neovim_lspconfig: None,
        };
        let installer = Installer::new(paths, Platform::new("linux", "x64", Some("gnu")));
        let progress = NoProgressSink;
        let err = installer
            .install_normalized_for_request("install", package, false, false, &progress)
            .unwrap_err();
        assert!(matches!(err, M4aError::BuildScriptsDisabled { .. }));
    }

    #[test]
    fn missing_package_manager_is_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("stage");
        let src = NormalizedSource {
            id: "pkg:opam/acme@1.0.0".to_owned(),
            source_type: "opam".to_owned(),
            namespace: None,
            package: "acme".to_owned(),
            version: "1.0.0".to_owned(),
            asset: None,
            extra_packages: vec![],
            build_scripts: vec![],
            qualifiers: BTreeMap::new(),
            subpath: None,
            build: None,
            download: None,
        };
        let package = NormalizedPackage {
            name: "opam-tool".to_owned(),
            version: "1.0.0".to_owned(),
            description: None,
            languages: vec![],
            categories: vec![],
            deprecated: false,
            source: src,
            bins: BTreeMap::new(),
            share: BTreeMap::new(),
            opt: BTreeMap::new(),
            neovim_lspconfig: None,
        };
        if !manager::command_exists("opam") {
            let progress = NoProgressSink;
            let err =
                install_with_manager_with_progress(&package, &staging, "install", false, &progress)
                    .unwrap_err();
            assert!(
                matches!(err, M4aError::MissingManager { source_type, .. } if source_type == "opam")
            );
        }
    }
}
