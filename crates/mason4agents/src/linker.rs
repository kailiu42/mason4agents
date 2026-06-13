use crate::installer::{normalized_link_path, validate_link_path, validate_package_name};
use crate::paths::MasonPaths;
use crate::store::InstalledPackage;
use crate::types::{msg, Result};
use std::collections::BTreeMap;
use std::ffi::OsStr;
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
        if let Err(e) = validate_link_path(name) {
            return Err(msg(format!(
                "package '{package_name}' has invalid share name '{name}': {e}"
            )));
        }
    }
    for name in opt.keys() {
        if let Err(e) = validate_link_path(name) {
            return Err(msg(format!(
                "package '{package_name}' has invalid opt name '{name}': {e}"
            )));
        }
    }

    let active_share = active_link_entries(package_dir, share);
    let active_opt = active_link_entries(package_dir, opt);
    ensure_nonconflicting_link_destinations("share", &active_share)?;
    ensure_nonconflicting_link_destinations("opt", &active_opt)?;
    let mut linked_bins = BTreeMap::new();
    let mut linked_share = BTreeMap::new();
    let mut linked_opt = BTreeMap::new();
    let result = (|| -> Result<()> {
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
        for (name, rel) in sorted_link_entries(share)? {
            let source = package_dir.join(rel);
            if !path_is_within(&source, package_dir) {
                return Err(msg(format!(
                    "share source escapes package directory: {} (rel: {})",
                    source.display(),
                    rel,
                )));
            }
            if source.exists() {
                ensure_link_parent_chain_safe(&paths.share_dir, name, package_dir)?;
                let dest = link_path(&paths.share_dir, name)?;
                if should_materialize_directory_link(name, share, package_dir)? {
                    let link_name = normalized_link_path(name)?;
                    materialize_directory_link(
                        &source,
                        &dest,
                        &link_name,
                        share,
                        package_dir,
                        &paths.share_dir,
                    )?;
                } else {
                    replace_owned_or_missing_link(&source, &dest, package_dir)?;
                }
                linked_share.insert(name.clone(), rel.clone());
            }
        }
        for (name, rel) in sorted_link_entries(opt)? {
            let source = package_dir.join(rel);
            if !path_is_within(&source, package_dir) {
                return Err(msg(format!(
                    "opt source escapes package directory: {} (rel: {})",
                    source.display(),
                    rel,
                )));
            }
            if source.exists() {
                ensure_link_parent_chain_safe(&paths.opt_dir, name, package_dir)?;
                let dest = link_path(&paths.opt_dir, name)?;
                if should_materialize_directory_link(name, opt, package_dir)? {
                    let link_name = normalized_link_path(name)?;
                    materialize_directory_link(
                        &source,
                        &dest,
                        &link_name,
                        opt,
                        package_dir,
                        &paths.opt_dir,
                    )?;
                } else {
                    replace_owned_or_missing_link(&source, &dest, package_dir)?;
                }
                linked_opt.insert(name.clone(), rel.clone());
            }
        }
        Ok(())
    })();
    if let Err(err) = result {
        cleanup_package_links(
            paths,
            &InstalledPackage {
                name: package_name.to_owned(),
                version: String::new(),
                source_id: String::new(),
                bins: linked_bins,
                share: linked_share,
                opt: linked_opt,
                installed_at: chrono::Utc::now(),
            },
        )?;
        return Err(err);
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
            let cmd_path = windows_wrapper_path(&link_path);
            if link_belongs_to_package(&cmd_path, &package_dir) {
                remove_path_if_exists(&cmd_path)?;
            }
        }
    }
    for name in installed.share.keys() {
        cleanup_managed_link(&paths.share_dir, name, &package_dir)?;
    }
    for name in installed.opt.keys() {
        cleanup_managed_link(&paths.opt_dir, name, &package_dir)?;
    }
    Ok(())
}

fn link_path(base: &Path, name: &str) -> Result<PathBuf> {
    Ok(base.join(normalized_link_path(name)?))
}

fn cleanup_managed_link(base: &Path, name: &str, package_dir: &Path) -> Result<()> {
    let link_path = link_path(base, name)?;
    if link_parent_chain_contains_symlink(base, &link_path)? {
        return Ok(());
    }
    remove_owned_link_path(&link_path, package_dir)?;
    #[cfg(windows)]
    {
        let cmd_path = windows_wrapper_path(&link_path);
        remove_owned_link_path(&cmd_path, package_dir)?;
    }
    Ok(())
}

fn remove_owned_link_path(path: &Path, package_dir: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            remove_owned_directory_contents(path, package_dir)?;
            remove_empty_dir_if_empty(path)?;
        }
        Ok(_) => {
            if link_belongs_to_package(path, package_dir) {
                remove_path_if_exists(path)?;
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

fn remove_owned_directory_contents(dir: &Path, package_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            remove_owned_directory_contents(&path, package_dir)?;
            remove_empty_dir_if_empty(&path)?;
        } else if directory_entry_belongs_to_package(&path, package_dir) {
            remove_path_if_exists(&path)?;
        }
    }
    Ok(())
}

fn remove_empty_dir_if_empty(dir: &Path) -> Result<()> {
    match fs::remove_dir(dir) {
        Ok(()) => Ok(()),
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

fn link_parent_chain_contains_symlink(base: &Path, path: &Path) -> Result<bool> {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == base {
            break;
        }
        match fs::symlink_metadata(dir) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(metadata) if !metadata.is_dir() => return Ok(true),
            Ok(_) => current = dir.parent(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => current = dir.parent(),
            Err(err) => return Err(err.into()),
        }
    }
    Ok(false)
}

fn active_link_entries(
    package_dir: &Path,
    entries: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    entries
        .iter()
        .filter_map(|(name, rel)| {
            let source = package_dir.join(rel);
            (path_is_within(&source, package_dir) && source.exists())
                .then(|| (name.clone(), rel.clone()))
        })
        .collect()
}

fn sorted_link_entries(entries: &BTreeMap<String, String>) -> Result<Vec<(&String, &String)>> {
    let mut sorted = entries
        .iter()
        .map(|(name, rel)| Ok((normalized_link_path(name)?, name, rel)))
        .collect::<Result<Vec<_>>>()?;
    sorted.sort_by(|(left_path, left_name, _), (right_path, right_name, _)| {
        left_path
            .cmp(right_path)
            .then_with(|| left_name.cmp(right_name))
    });
    Ok(sorted
        .into_iter()
        .map(|(_, name, rel)| (name, rel))
        .collect())
}

fn ensure_nonconflicting_link_destinations(
    kind: &str,
    entries: &BTreeMap<String, String>,
) -> Result<()> {
    let normalized = entries
        .iter()
        .map(|(name, rel)| Ok((name, normalized_link_path(name)?, rel)))
        .collect::<Result<Vec<_>>>()?;
    for (index, (left_name, left_path, left_rel)) in normalized.iter().enumerate() {
        for (right_name, right_path, right_rel) in normalized.iter().skip(index + 1) {
            if left_path == right_path
                || (left_path.starts_with(right_path)
                    && !directory_link_covers_child(
                        right_name, right_path, right_rel, left_path, left_rel,
                    ))
                || (right_path.starts_with(left_path)
                    && !directory_link_covers_child(
                        left_name, left_path, left_rel, right_path, right_rel,
                    ))
            {
                return Err(msg(format!(
                    "conflicting {kind} link destinations: '{left_name}' conflicts with '{right_name}'"
                )));
            }
        }
    }
    Ok(())
}

fn directory_link_covers_child(
    parent_name: &str,
    _parent_path: &Path,
    _parent_rel: &str,
    _child_path: &Path,
    _child_rel: &str,
) -> bool {
    parent_name.ends_with('/')
}

fn should_materialize_directory_link(
    name: &str,
    entries: &BTreeMap<String, String>,
    package_dir: &Path,
) -> Result<bool> {
    if !name.ends_with('/') {
        return Ok(false);
    }
    let parent = normalized_link_path(name)?;
    for (child_name, child_rel) in entries {
        if child_name == name {
            continue;
        }
        let child = normalized_link_path(child_name)?;
        let child_source = package_dir.join(child_rel);
        if child.starts_with(&parent)
            && path_is_within(&child_source, package_dir)
            && child_source.exists()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_link_parent_chain_safe(base: &Path, name: &str, _package_dir: &Path) -> Result<()> {
    let dest = link_path(base, name)?;
    let mut current = dest.parent();
    while let Some(dir) = current {
        if dir == base {
            break;
        }
        match fs::symlink_metadata(dir) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(msg(format!(
                    "link destination parent '{}' is a symlink; nested link '{}' is unsafe",
                    dir.display(),
                    name
                )));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(msg(format!(
                    "link destination parent '{}' is not a directory; nested link '{}' is unsafe",
                    dir.display(),
                    name
                )));
            }
            Ok(_) => current = dir.parent(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => current = dir.parent(),
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn missing_link_parent_dirs(base: &Path, path: &Path) -> Vec<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == base {
            break;
        }
        if matches!(
            fs::symlink_metadata(dir),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound
        ) {
            missing.push(dir.to_owned());
        }
        current = dir.parent();
    }
    missing
}

fn remove_created_empty_dirs(dirs: &[PathBuf]) -> Result<()> {
    for dir in dirs {
        match fs::remove_dir(dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) if err.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}
fn materialize_directory_link(
    source: &Path,
    dest: &Path,
    link_name: &Path,
    entries: &BTreeMap<String, String>,
    package_dir: &Path,
    base: &Path,
) -> Result<()> {
    let created_parent_dirs = missing_link_parent_dirs(base, dest);
    let mut created_dest = false;
    let mut prepared_dest = false;
    let result = (|| -> Result<()> {
        if !source.is_dir() {
            return Err(msg(format!(
                "directory link source '{}' is not a directory",
                source.display()
            )));
        }
        created_dest = prepare_materialized_directory_dest(dest, package_dir)?;
        prepared_dest = true;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let source_child = entry.path();
            let file_name = entry.file_name();
            let dest_child = dest.join(&file_name);
            let link_child = link_name.join(&file_name);
            let has_descendant = has_requested_descendant(&link_child, entries, package_dir)?;
            if has_descendant {
                if !source_child.is_dir() {
                    return Err(msg(format!(
                        "directory link source '{}' is not a directory but has nested link destinations",
                        source_child.display()
                    )));
                }
                materialize_directory_link(
                    &source_child,
                    &dest_child,
                    &link_child,
                    entries,
                    package_dir,
                    base,
                )?;
            } else {
                replace_materialized_child_link(&source_child, &dest_child, package_dir)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        if created_dest {
            let _ = remove_path_if_exists(dest);
        } else if prepared_dest {
            let _ = remove_owned_directory_contents(dest, package_dir);
        }
        let _ = remove_created_empty_dirs(&created_parent_dirs);
    }
    result
}

fn prepare_materialized_directory_dest(dest: &Path, package_dir: &Path) -> Result<bool> {
    match fs::symlink_metadata(dest) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(false),
        Ok(metadata)
            if metadata.file_type().is_symlink()
                && symlink_points_to_package(dest, package_dir) =>
        {
            remove_path_if_exists(dest)?;
            fs::create_dir_all(dest)?;
            Ok(true)
        }
        Ok(_) => Err(msg(format!(
            "link destination '{}' already exists and is not owned by this package",
            dest.display()
        ))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dest)?;
            Ok(true)
        }
        Err(err) => Err(err.into()),
    }
}

fn replace_materialized_child_link(source: &Path, dest: &Path, package_dir: &Path) -> Result<()> {
    replace_owned_or_missing_link(source, dest, package_dir)
}

fn replace_owned_or_missing_link(source: &Path, dest: &Path, package_dir: &Path) -> Result<()> {
    if existing_destination_points_to_source(dest, source)? {
        return Ok(());
    }
    match fs::symlink_metadata(dest) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                && symlink_points_to_package(dest, package_dir) =>
        {
            remove_path_if_exists(dest)?;
        }
        Ok(_) => {
            return Err(msg(format!(
                "link destination '{}' already exists and is not owned by this package",
                dest.display()
            )));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    ensure_windows_wrapper_destination_safe(dest, package_dir)?;
    replace_link(source, dest)
}

fn has_requested_descendant(
    link_name: &Path,
    entries: &BTreeMap<String, String>,
    package_dir: &Path,
) -> Result<bool> {
    for (child_name, child_rel) in entries {
        let child = normalized_link_path(child_name)?;
        let child_source = package_dir.join(child_rel);
        if child != link_name
            && child.starts_with(link_name)
            && path_is_within(&child_source, package_dir)
            && child_source.exists()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn existing_destination_points_to_source(dest: &Path, source: &Path) -> Result<bool> {
    if !dest.exists() {
        return Ok(false);
    }
    let source = source.canonicalize()?;
    let dest = dest.canonicalize()?;
    Ok(source == dest)
}

fn directory_entry_belongs_to_package(path: &Path, package_dir: &Path) -> bool {
    symlink_points_to_package(path, package_dir)
        || generated_wrapper_points_to_package(path, package_dir)
}

fn generated_wrapper_points_to_package(path: &Path, package_dir: &Path) -> bool {
    if path.extension() != Some(OsStr::new("cmd")) {
        return false;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Some(target) = content
        .strip_prefix("@echo off\r\n\"")
        .and_then(|content| content.strip_suffix("\" %*\r\n"))
    else {
        return false;
    };
    let Ok(target) = Path::new(target).canonicalize() else {
        return false;
    };
    let Ok(package_dir) = package_dir.canonicalize() else {
        return false;
    };
    target.starts_with(package_dir)
}

#[cfg(windows)]
fn ensure_windows_wrapper_destination_safe(dest: &Path, package_dir: &Path) -> Result<()> {
    let wrapper = windows_wrapper_path(dest);
    match fs::symlink_metadata(&wrapper) {
        Ok(_) if generated_wrapper_points_to_package(&wrapper, package_dir) => Ok(()),
        Ok(_) => Err(msg(format!(
            "link destination '{}' already exists and is not owned by this package",
            wrapper.display()
        ))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

#[cfg(not(windows))]
fn ensure_windows_wrapper_destination_safe(_dest: &Path, _package_dir: &Path) -> Result<()> {
    Ok(())
}

fn symlink_points_to_package(path: &Path, package_dir: &Path) -> bool {
    match std::fs::read_link(path) {
        Ok(target) => target.canonicalize().ok().is_some_and(|canon_target| {
            package_dir
                .canonicalize()
                .ok()
                .is_some_and(|canon_pkg| canon_target.starts_with(&canon_pkg))
        }),
        Err(_) => false,
    }
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
    } else if let Some(rel) = spec.strip_prefix("python:") {
        package_dir.join(rel)
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
pub fn windows_wrapper_path(dest: &Path) -> PathBuf {
    let mut wrapper_name = dest
        .file_name()
        .map(OsStr::to_os_string)
        .unwrap_or_else(|| dest.as_os_str().to_os_string());
    wrapper_name.push(".cmd");
    dest.with_file_name(wrapper_name)
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
        fs::write(windows_wrapper_path(dest), windows_cmd_wrapper(source))?;
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
    fn allows_nested_share_links_and_rejects_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config_linux")).unwrap();
        fs::write(pkg.join("lombok.jar"), b"jar").unwrap();

        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/config/".to_owned(), "config_linux".to_owned()),
                ("jdtls/lombok.jar".to_owned(), "lombok.jar".to_owned()),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(receipt.share.len(), 2);
        assert!(paths.share_dir.join("jdtls/config").exists());
        assert!(paths.share_dir.join("jdtls/lombok.jar").exists());

        let installed = InstalledPackage {
            name: "jdtls".to_owned(),
            version: "1".to_owned(),
            source_id: "pkg:generic/eclipse/eclipse.jdt.ls@1".to_owned(),
            bins: BTreeMap::new(),
            share: receipt.share,
            opt: BTreeMap::new(),
            installed_at: Utc::now(),
        };
        cleanup_package_links(&paths, &installed).unwrap();
        assert!(!paths.share_dir.join("jdtls/config").exists());
        assert!(!paths.share_dir.join("jdtls/lombok.jar").exists());
        assert!(paths.share_dir.join("jdtls").exists());

        assert!(create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([("../evil".to_owned(), "lombok.jar".to_owned())]),
            &BTreeMap::new(),
        )
        .is_err());
        assert!(create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/config".to_owned(), "config_linux".to_owned()),
                ("jdtls/config/".to_owned(), "config_linux".to_owned()),
            ]),
            &BTreeMap::new(),
        )
        .is_err());
        fs::create_dir_all(pkg.join("config/plugins")).unwrap();
        fs::write(pkg.join("config/plugins/foo.jar"), b"jar").unwrap();
        let materialized = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "config/plugins/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(materialized.share.len(), 2);
        assert!(paths.share_dir.join("jdtls/plugins/foo.jar").exists());
        assert!(!fs::symlink_metadata(paths.share_dir.join("jdtls/plugins"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(pkg.join("config/plugins/foo.jar").exists());
    }
    #[test]
    fn direct_nested_link_rejects_unowned_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        fs::create_dir_all(paths.share_dir.join("jdtls/config")).unwrap();
        fs::write(paths.share_dir.join("jdtls/config/external.txt"), b"keep").unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config_linux")).unwrap();
        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([("jdtls/config/".to_owned(), "config_linux".to_owned())]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("already exists and is not owned"));
        assert_eq!(
            fs::read(paths.share_dir.join("jdtls/config/external.txt")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn materialized_directory_preserves_existing_destination_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        fs::create_dir_all(paths.share_dir.join("jdtls")).unwrap();
        fs::write(paths.share_dir.join("jdtls/external.txt"), b"keep").unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config/plugins")).unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("config/plugins/foo.jar"), b"base").unwrap();
        fs::write(pkg.join("override/foo.jar"), b"override").unwrap();

        create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            fs::read(paths.share_dir.join("jdtls/external.txt")).unwrap(),
            b"keep"
        );
        assert!(paths.share_dir.join("jdtls/plugins/foo.jar").exists());
    }

    #[test]
    fn cleanup_materialized_directory_preserves_unowned_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config/plugins")).unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("config/plugins/foo.jar"), b"base").unwrap();
        fs::write(pkg.join("override/foo.jar"), b"override").unwrap();

        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();
        fs::write(paths.share_dir.join("jdtls/external.txt"), b"keep").unwrap();

        cleanup_package_links(
            &paths,
            &InstalledPackage {
                name: "jdtls".to_owned(),
                version: "1".to_owned(),
                source_id: "pkg:generic/eclipse/eclipse.jdt.ls@1".to_owned(),
                bins: BTreeMap::new(),
                share: receipt.share,
                opt: BTreeMap::new(),
                installed_at: Utc::now(),
            },
        )
        .unwrap();

        assert_eq!(
            fs::read(paths.share_dir.join("jdtls/external.txt")).unwrap(),
            b"keep"
        );
        assert!(!paths.share_dir.join("jdtls/plugins/foo.jar").exists());
    }

    #[test]
    fn rejects_nested_link_under_existing_prefix_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();

        let owner_pkg = paths.package_dir("owner");
        fs::create_dir_all(owner_pkg.join("config")).unwrap();
        replace_link(&owner_pkg.join("config"), &paths.share_dir.join("jdtls")).unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config_linux")).unwrap();
        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([("jdtls/config".to_owned(), "config_linux".to_owned())]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("is a symlink"));
        assert!(!owner_pkg.join("config/config").exists());
    }
    #[cfg(unix)]
    #[test]
    fn cleanup_skips_nested_link_under_symlink_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(&pkg).unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("config"), b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, paths.share_dir.join("jdtls")).unwrap();

        let installed = InstalledPackage {
            name: "jdtls".to_owned(),
            version: "1".to_owned(),
            source_id: "pkg:generic/eclipse/eclipse.jdt.ls@1".to_owned(),
            bins: BTreeMap::new(),
            share: BTreeMap::from([("jdtls/config".to_owned(), "config".to_owned())]),
            opt: BTreeMap::new(),
            installed_at: Utc::now(),
        };

        cleanup_package_links(&paths, &installed).unwrap();

        assert_eq!(fs::read(outside.join("config")).unwrap(), b"keep");
    }
    #[cfg(unix)]
    #[test]
    fn failed_materialized_directory_does_not_follow_unowned_symlink_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config/plugins")).unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("override/foo.jar"), b"jar").unwrap();
        fs::write(pkg.join("owned.jar"), b"owned").unwrap();

        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(pkg.join("owned.jar"), outside.join("owned.jar")).unwrap();
        fs::create_dir_all(paths.share_dir.join("jdtls")).unwrap();
        std::os::unix::fs::symlink(&outside, paths.share_dir.join("jdtls/plugins")).unwrap();

        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("already exists and is not owned"));
        assert!(paths.share_dir.join("jdtls/plugins").exists());
        assert!(outside.join("owned.jar").exists());
    }

    #[test]
    fn cleanup_preserves_preexisting_nested_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        fs::create_dir_all(paths.share_dir.join("jdtls")).unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config_linux")).unwrap();
        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([("jdtls/config".to_owned(), "config_linux".to_owned())]),
            &BTreeMap::new(),
        )
        .unwrap();

        let installed = InstalledPackage {
            name: "jdtls".to_owned(),
            version: "1".to_owned(),
            source_id: "pkg:generic/eclipse/eclipse.jdt.ls@1".to_owned(),
            bins: BTreeMap::new(),
            share: receipt.share,
            opt: BTreeMap::new(),
            installed_at: Utc::now(),
        };
        cleanup_package_links(&paths, &installed).unwrap();

        assert!(paths.share_dir.join("jdtls").is_dir());
        assert!(!paths.share_dir.join("jdtls/config").exists());
    }

    #[test]
    fn missing_parent_share_entry_does_not_conflict_with_active_child() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config_linux")).unwrap();

        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls".to_owned(), "missing".to_owned()),
                ("jdtls/config".to_owned(), "config_linux".to_owned()),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            receipt.share,
            BTreeMap::from([("jdtls/config".to_owned(), "config_linux".to_owned())])
        );
        assert!(paths.share_dir.join("jdtls/config").exists());
    }

    #[test]
    fn materialized_directory_ignores_missing_descendant_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config")).unwrap();
        fs::write(pkg.join("config/plugins"), b"regular file").unwrap();

        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "missing/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            receipt.share,
            BTreeMap::from([("jdtls/".to_owned(), "config".to_owned())])
        );
        assert!(paths.share_dir.join("jdtls/plugins").exists());
    }

    #[test]
    fn failed_materialized_directory_link_removes_partial_output() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config")).unwrap();
        fs::write(pkg.join("config/plugins"), b"not a directory").unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("override/foo.jar"), b"jar").unwrap();
        fs::write(pkg.join("other"), b"linked first").unwrap();

        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("aaa".to_owned(), "other".to_owned()),
                ("jdtls/".to_owned(), "config".to_owned()),
                (
                    "jdtls/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("has nested link destinations"));
        assert!(!paths.share_dir.join("aaa").exists());
        assert!(!paths.share_dir.join("jdtls").exists());
    }

    #[test]
    fn failed_nested_materialized_directory_preserves_preexisting_empty_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        fs::create_dir_all(paths.share_dir.join("jdtls")).unwrap();

        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config")).unwrap();
        fs::write(pkg.join("config/plugins"), b"not a directory").unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("override/foo.jar"), b"jar").unwrap();

        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/config/".to_owned(), "config".to_owned()),
                (
                    "jdtls/config/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("has nested link destinations"));
        assert!(paths.share_dir.join("jdtls").is_dir());
        assert!(!paths.share_dir.join("jdtls/config").exists());
    }

    #[test]
    fn nested_links_are_processed_in_normalized_path_order() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config/plugins")).unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("config/plugins/foo.jar"), b"base").unwrap();
        fs::write(pkg.join("override/foo.jar"), b"override").unwrap();

        let receipt = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                (
                    "jdtls//plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
                ("jdtls/plugins/".to_owned(), "config/plugins".to_owned()),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(receipt.share.len(), 2);
        assert!(paths.share_dir.join("jdtls/plugins/foo.jar").exists());
        assert_eq!(
            fs::read(paths.share_dir.join("jdtls/plugins/foo.jar")).unwrap(),
            b"override"
        );
        assert!(!fs::symlink_metadata(paths.share_dir.join("jdtls/plugins"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
    #[test]
    fn failed_nested_materialized_directory_prunes_empty_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = test_paths(tmp.path());
        paths.ensure_base_dirs().unwrap();
        let pkg = paths.package_dir("jdtls");
        fs::create_dir_all(pkg.join("config")).unwrap();
        fs::write(pkg.join("config/plugins"), b"not a directory").unwrap();
        fs::create_dir_all(pkg.join("override")).unwrap();
        fs::write(pkg.join("override/foo.jar"), b"jar").unwrap();

        let err = create_package_links(
            &paths,
            "jdtls",
            &pkg,
            &BTreeMap::new(),
            &BTreeMap::from([
                ("jdtls/config/".to_owned(), "config".to_owned()),
                (
                    "jdtls/config/plugins/foo.jar".to_owned(),
                    "override/foo.jar".to_owned(),
                ),
            ]),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("has nested link destinations"));
        assert!(!paths.share_dir.join("jdtls").exists());
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
        // python path relative to package root
        assert_eq!(
            resolve_bin_source(root, "python:bin/jdtls").unwrap(),
            PathBuf::from("/pkg/bin/jdtls")
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
    fn appends_windows_wrapper_extension_for_plain_name() {
        assert_eq!(
            windows_wrapper_path(Path::new("bin/foo")),
            PathBuf::from("bin/foo.cmd")
        );
    }

    #[test]
    fn appends_windows_wrapper_extension_for_name_with_dot() {
        assert_eq!(
            windows_wrapper_path(Path::new("bin/foo.bar")),
            PathBuf::from("bin/foo.bar.cmd")
        );
    }

    #[test]
    fn renders_windows_wrapper() {
        assert!(windows_cmd_wrapper(Path::new("C:/tool.exe")).contains("C:/tool.exe"));
    }
    #[test]
    fn generated_wrapper_ownership_requires_exact_cmd_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = tmp.path().join("pkg");
        fs::create_dir_all(pkg.join("bin")).unwrap();
        fs::write(pkg.join("bin/tool"), b"tool").unwrap();

        let wrapper = tmp.path().join("tool.cmd");
        fs::write(&wrapper, windows_cmd_wrapper(&pkg.join("bin/tool"))).unwrap();
        assert!(generated_wrapper_points_to_package(&wrapper, &pkg));

        let note = tmp.path().join("note.cmd");
        fs::write(&note, format!("mentions {}", pkg.display())).unwrap();
        assert!(!generated_wrapper_points_to_package(&note, &pkg));

        let text = tmp.path().join("tool.txt");
        fs::write(&text, windows_cmd_wrapper(&pkg.join("bin/tool"))).unwrap();
        assert!(!generated_wrapper_points_to_package(&text, &pkg));
    }
}
