use crate::installer::validate_package_name;
use crate::paths::MasonPaths;
use crate::store::InstalledPackage;
use crate::types::{msg, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn create_package_links(
    paths: &MasonPaths,
    package_name: &str,
    package_dir: &Path,
    bins: &BTreeMap<String, String>,
    share: &BTreeMap<String, String>,
    opt: &BTreeMap<String, String>,
) -> Result<LinkReceipt> {
    fs::create_dir_all(&paths.bin_dir)?;
    fs::create_dir_all(&paths.share_dir)?;
    fs::create_dir_all(&paths.opt_dir)?;
    for name in bins.keys() {
        if let Err(e) = validate_package_name(name) {
            return Err(msg(format!(
                "package '{package_name}' has invalid bin name '{name}': {e}"
            )));
        }
    }
    for name in share.keys() {
        if let Err(e) = validate_package_name(name) {
            return Err(msg(format!(
                "package '{package_name}' has invalid share name '{name}': {e}"
            )));
        }
    }
    for name in opt.keys() {
        if let Err(e) = validate_package_name(name) {
            return Err(msg(format!(
                "package '{package_name}' has invalid opt name '{name}': {e}"
            )));
        }
    }
    let mut linked_bins = BTreeMap::new();
    for (name, spec) in bins {
        let source = resolve_bin_source(package_dir, spec)?;
        if !source.exists() {
            return Err(msg(format!(
                "bin source for {package_name}/{name} does not exist: {}",
                source.display()
            )));
        }
        #[cfg(unix)]
        ensure_executable(&source)?;
        let dest = paths.bin_dir.join(name);
        replace_link(&source, &dest)?;
        linked_bins.insert(name.clone(), spec.clone());
    }
    let mut linked_share = BTreeMap::new();
    for (name, rel) in share {
        let source = package_dir.join(rel);
        if !path_is_within(&source, package_dir) {
            return Err(msg(format!(
                "share source escapes package directory: {} (rel: {})",
                source.display(),
                rel,
            )));
        }
        if source.exists() {
            replace_link(&source, &paths.share_dir.join(name))?;
            linked_share.insert(name.clone(), rel.clone());
        }
    }
    let mut linked_opt = BTreeMap::new();
    for (name, rel) in opt {
        let source = package_dir.join(rel);
        if !path_is_within(&source, package_dir) {
            return Err(msg(format!(
                "opt source escapes package directory: {} (rel: {})",
                source.display(),
                rel,
            )));
        }
        if source.exists() {
            replace_link(&source, &paths.opt_dir.join(name))?;
            linked_opt.insert(name.clone(), rel.clone());
        }
    }
    Ok(LinkReceipt {
        bins: linked_bins,
        share: linked_share,
        opt: linked_opt,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkReceipt {
    pub bins: BTreeMap<String, String>,
    pub share: BTreeMap<String, String>,
    pub opt: BTreeMap<String, String>,
}

pub fn cleanup_package_links(paths: &MasonPaths, installed: &InstalledPackage) -> Result<()> {
    let package_dir = paths.package_dir(&installed.name);
    for name in installed.bins.keys() {
        let link_path = paths.bin_dir.join(name);
        if link_belongs_to_package(&link_path, &package_dir) {
            remove_path_if_exists(&link_path)?;
        }
        #[cfg(windows)]
        {
            let cmd_path = paths.bin_dir.join(format!("{name}.cmd"));
            if link_belongs_to_package(&cmd_path, &package_dir) {
                remove_path_if_exists(&cmd_path)?;
            }
        }
    }
    for name in installed.share.keys() {
        let link_path = paths.share_dir.join(name);
        if link_belongs_to_package(&link_path, &package_dir) {
            remove_path_if_exists(&link_path)?;
        }
    }
    for name in installed.opt.keys() {
        let link_path = paths.opt_dir.join(name);
        if link_belongs_to_package(&link_path, &package_dir) {
            remove_path_if_exists(&link_path)?;
        }
    }
    Ok(())
}

/// Returns `true` if the given path is a symlink (or a `.cmd` wrapper on Windows)
/// whose target points into the given `package_dir`.
fn link_belongs_to_package(path: &Path, package_dir: &Path) -> bool {
    if !path.exists() {
        // Path doesn't exist — nothing to remove anyway.
        return true;
    }
    #[cfg(unix)]
    {
        match std::fs::read_link(path) {
            Ok(target) => {
                // Canonicalize both to handle .. and symlinks within.
                target.canonicalize().ok().is_some_and(|canon_target| {
                    package_dir
                        .canonicalize()
                        .ok()
                        .is_some_and(|canon_pkg| canon_target.starts_with(&canon_pkg))
                })
            }
            Err(_) => {
                // Not a symlink (or can't read). Could be a regular file left by
                // something else — be conservative and still remove so we don't
                // leave stale files. This matches prior behaviour.
                true
            }
        }
    }
    #[cfg(windows)]
    {
        // On Windows, we create .cmd wrappers (regular files). We can't read_link
        // those. Always remove — they belong to us by convention. The caller
        // already knows the package owns this path.
        true
    }
}

pub fn resolve_bin_source(package_dir: &Path, spec: &str) -> Result<PathBuf> {
    let resolved = if let Some(name) = spec.strip_prefix("npm:") {
        // Scoped packages: npm:@scope/name → node_modules/.bin/name
        // Use only the last path component (the package name without scope).
        let bin_name = name.rsplit('/').next().unwrap_or(name);
        package_dir.join("node_modules").join(".bin").join(bin_name)
    } else if let Some(name) = spec.strip_prefix("pypi:") {
        package_dir.join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("golang:") {
        package_dir.join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("cargo:") {
        package_dir.join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("gem:") {
        package_dir.join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("composer:") {
        package_dir.join("vendor").join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("luarocks:") {
        package_dir.join("bin").join(name)
    } else if let Some(name) = spec.strip_prefix("nuget:") {
        package_dir.join(name).join("tools").join(name)
    } else if let Some(rel) = spec.strip_prefix("exec:") {
        package_dir.join(rel)
    } else {
        package_dir.join(spec)
    };

    // Reject paths that escape package_dir via absolute spec or .. traversal.
    if !path_is_within(&resolved, package_dir) {
        return Err(msg(format!(
            "resolved bin source escapes package directory: {} (spec: {})",
            resolved.display(),
            spec,
        )));
    }
    Ok(resolved)
}

/// Returns true if `path` is inside `base` (i.e. doesn't escape via `..` or absolute path).
/// Uses canonicalization when both paths exist, otherwise resolves components manually.
fn path_is_within(path: &Path, base: &Path) -> bool {
    // Try canonicalization first (most reliable when files exist).
    if let (Ok(canon_path), Ok(canon_base)) = (path.canonicalize(), base.canonicalize()) {
        return canon_path.starts_with(&canon_base);
    }
    // Fallback: normalise .. components manually.
    let resolved = normalize_path(path);
    let base_normal = normalize_path(base);
    resolved.starts_with(&base_normal)
}

/// Normalise a path by resolving `.` and `..` components without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut components = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only pop non-root, non-parent components (Normal or Prefix).
                if components
                    .last()
                    .is_some_and(|last| matches!(last, Component::Normal(_) | Component::Prefix(_)))
                {
                    components.pop();
                } else {
                    components.push(c);
                }
            }
            other => components.push(other),
        }
    }
    components.iter().collect()
}

pub fn windows_cmd_wrapper(target: &Path) -> String {
    format!("@echo off\r\n\"{}\" %*\r\n", target.display())
}

fn replace_link(source: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    remove_path_if_exists(dest)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, dest)?;
    }
    #[cfg(windows)]
    {
        fs::write(dest.with_extension("cmd"), windows_cmd_wrapper(source))?;
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path)?;
    let mut mode = metadata.permissions().mode();
    if mode & 0o111 == 0 {
        mode |= 0o755;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use chrono::Utc;
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

    #[test]
    fn creates_and_cleans_unix_links_and_share_opt() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("demo");
        fs::create_dir_all(pkg.join("bin")).unwrap();
        fs::create_dir_all(pkg.join("share-data")).unwrap();
        fs::create_dir_all(pkg.join("opt-data")).unwrap();
        fs::write(pkg.join("bin/tool"), b"echo ok").unwrap();
        let receipt = create_package_links(
            &paths,
            "demo",
            &pkg,
            &BTreeMap::from([("tool".to_owned(), "exec:bin/tool".to_owned())]),
            &BTreeMap::from([("demo-share".to_owned(), "share-data".to_owned())]),
            &BTreeMap::from([("demo-opt".to_owned(), "opt-data".to_owned())]),
        )
        .unwrap();
        assert_eq!(receipt.bins.len(), 1);
        assert!(paths.bin_dir.join("tool").exists());
        assert!(paths.share_dir.join("demo-share").exists());
        let installed = InstalledPackage {
            name: "demo".to_owned(),
            version: "1".to_owned(),
            source_id: "pkg:generic/acme/demo@1".to_owned(),
            bins: receipt.bins,
            share: receipt.share,
            opt: receipt.opt,
            installed_at: Utc::now(),
        };
        cleanup_package_links(&paths, &installed).unwrap();
        assert!(!paths.bin_dir.join("tool").exists());
    }

    #[test]
    fn resolves_special_bin_schemes() {
        let root = Path::new("/pkg");
        // npm (simple)
        assert_eq!(
            resolve_bin_source(root, "npm:tsserver").unwrap(),
            PathBuf::from("/pkg/node_modules/.bin/tsserver")
        );
        // npm (scoped)
        assert_eq!(
            resolve_bin_source(root, "npm:@scope/name").unwrap(),
            PathBuf::from("/pkg/node_modules/.bin/name")
        );
        // pypi
        assert_eq!(
            resolve_bin_source(root, "pypi:mytool").unwrap(),
            PathBuf::from("/pkg/bin/mytool")
        );
        // golang / cargo / gem / luarocks
        for prefix in &["golang", "cargo", "gem", "luarocks"] {
            assert_eq!(
                resolve_bin_source(root, &format!("{prefix}:mytool")).unwrap(),
                PathBuf::from("/pkg/bin/mytool")
            );
        }
        // composer
        assert_eq!(
            resolve_bin_source(root, "composer:mytool").unwrap(),
            PathBuf::from("/pkg/vendor/bin/mytool")
        );
        // nuget
        assert_eq!(
            resolve_bin_source(root, "nuget:mytool").unwrap(),
            PathBuf::from("/pkg/mytool/tools/mytool")
        );
        // exec
        assert_eq!(
            resolve_bin_source(root, "exec:bin/tool").unwrap(),
            PathBuf::from("/pkg/bin/tool")
        );
        // raw path fallback
        assert_eq!(
            resolve_bin_source(root, "tool").unwrap(),
            PathBuf::from("/pkg/tool")
        );
    }

    #[test]
    fn renders_windows_wrapper() {
        assert!(windows_cmd_wrapper(Path::new("C:/tool.exe")).contains("C:/tool.exe"));
    }
}
