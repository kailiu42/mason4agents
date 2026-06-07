use crate::download::{fetch_bytes_with_progress, local_path};
use crate::package_spec::{NormalizedPackage, RawPackageSpec};
use crate::paths::MasonPaths;
use crate::platform::Platform;
use crate::progress::{emit_error, NoProgressSink, ProgressSink, ProgressStatus};
use crate::store::InstalledState;
use crate::types::{msg, M4aError, Result};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const DEFAULT_REGISTRY_URL: &str =
    "https://github.com/mason-org/mason-registry/archive/refs/heads/main.zip";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryCache {
    pub refreshed_at: DateTime<Utc>,
    pub source: String,
    pub packages: BTreeMap<String, RawPackageSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageSummary {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub languages: Vec<String>,
    pub categories: Vec<String>,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub outdated: bool,
    pub deprecated: bool,
    pub neovim_lspconfig: Option<String>,
    #[serde(default)]
    pub requires_build_scripts: bool,
    #[serde(default)]
    pub build_scripts: Vec<String>,
    #[serde(default)]
    pub extra_packages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefreshSummary {
    pub source: String,
    pub package_count: usize,
    pub cache_file: PathBuf,
    pub checksum: String,
}
struct RegistryCacheLock {
    file: File,
}

impl RegistryCacheLock {
    fn acquire_shared(paths: &MasonPaths) -> Result<Self> {
        let file = open_registry_lock_file(paths)?;
        file.lock_shared()?;
        Ok(Self { file })
    }

    fn acquire_exclusive(paths: &MasonPaths) -> Result<Self> {
        let file = open_registry_lock_file(paths)?;
        file.lock_exclusive()?;
        Ok(Self { file })
    }
}

impl Drop for RegistryCacheLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn open_registry_lock_file(paths: &MasonPaths) -> Result<File> {
    fs::create_dir_all(&paths.locks_dir)?;
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.locks_dir.join("registry.lock"))?)
}

pub fn refresh_registry(paths: &MasonPaths, source: Option<&str>) -> Result<RefreshSummary> {
    let progress = NoProgressSink;
    refresh_registry_with_progress(paths, source, &progress)
}

pub fn refresh_registry_with_progress(
    paths: &MasonPaths,
    source: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<RefreshSummary> {
    let result = (|| -> Result<RefreshSummary> {
        paths.ensure_base_dirs()?;
        let source = source.unwrap_or(DEFAULT_REGISTRY_URL).to_owned();
        progress.event(
            "refresh",
            "registry",
            ProgressStatus::Started,
            None,
            "loading registry source",
        );
        let packages = load_registry_source_with_progress(&source, progress)?;
        progress.event(
            "refresh",
            "registry",
            ProgressStatus::Running,
            None,
            "writing registry cache",
        );
        let cache = RegistryCache {
            refreshed_at: Utc::now(),
            source: source.clone(),
            packages,
        };
        let bytes = serde_json::to_vec_pretty(&cache)?;
        let checksum = hex::encode(Sha256::digest(&bytes));
        let _lock = RegistryCacheLock::acquire_exclusive(paths)?;
        commit_registry_cache(paths, &bytes, checksum.as_bytes())?;
        Ok(RefreshSummary {
            source,
            package_count: cache.packages.len(),
            cache_file: paths.registry_index_file(),
            checksum,
        })
    })();
    match &result {
        Ok(_) => progress.event(
            "refresh",
            "registry",
            ProgressStatus::Succeeded,
            None,
            "registry refreshed",
        ),
        Err(err) => emit_error(progress, "refresh", "registry", None, err),
    }
    result
}

fn commit_registry_cache(
    paths: &MasonPaths,
    index_bytes: &[u8],
    checksum_bytes: &[u8],
) -> Result<()> {
    fs::create_dir_all(&paths.registry_dir)?;
    let index = paths.registry_index_file();
    let checksum = paths.registry_checksum_file();
    let previous_index = read_file_if_exists(&index)?;
    let previous_checksum = read_file_if_exists(&checksum)?;
    let tmp_index = write_registry_temp_file(&paths.registry_dir, &index, index_bytes)?;
    let tmp_checksum = write_registry_temp_file(&paths.registry_dir, &checksum, checksum_bytes)?;

    let result = (|| -> Result<()> {
        remove_file_if_exists(&checksum)?;
        replace_file(&tmp_index, &index)?;
        #[cfg(test)]
        maybe_fail_registry_commit_for_test(&checksum)?;
        replace_file(&tmp_checksum, &checksum)?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = fs::remove_file(&tmp_index);
        let _ = fs::remove_file(&tmp_checksum);
        rollback_registry_cache(
            &paths.registry_dir,
            &index,
            previous_index.as_deref(),
            &checksum,
            previous_checksum.as_deref(),
        )?;
        return Err(err);
    }
    Ok(())
}

fn rollback_registry_cache(
    parent: &Path,
    index: &Path,
    previous_index: Option<&[u8]>,
    checksum: &Path,
    previous_checksum: Option<&[u8]>,
) -> Result<()> {
    restore_registry_file(parent, index, previous_index)?;
    restore_registry_file(parent, checksum, previous_checksum)?;
    Ok(())
}

fn restore_registry_file(parent: &Path, dest: &Path, previous: Option<&[u8]>) -> Result<()> {
    match previous {
        Some(bytes) => write_atomically(parent, dest, bytes),
        None => {
            remove_file_if_exists(dest)?;
            Ok(())
        }
    }
}

fn write_atomically(parent: &Path, dest: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = write_registry_temp_file(parent, dest, bytes)?;
    if let Err(err) = replace_file(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn write_registry_temp_file(parent: &Path, dest: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let filename = dest
        .file_name()
        .ok_or_else(|| msg(format!("registry path has no filename: {}", dest.display())))?
        .to_string_lossy();
    for counter in 0..100_u64 {
        let tmp = parent.join(format!(".{filename}.tmp-{}-{counter}", std::process::id()));
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
    Err(msg(format!(
        "could not create unique registry temp file for {}",
        dest.display()
    )))
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
    let parent = dest
        .parent()
        .ok_or_else(|| msg(format!("registry path has no parent: {}", dest.display())))?;
    let filename = dest
        .file_name()
        .ok_or_else(|| msg(format!("registry path has no filename: {}", dest.display())))?
        .to_string_lossy();
    for counter in 0..100_u64 {
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
    Err(msg(format!(
        "could not create unique registry backup file for {}",
        dest.display()
    )))
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, dest: &Path) -> Result<()> {
    Ok(fs::rename(tmp, dest)?)
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn read_file_if_exists(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
static FAIL_REGISTRY_CHECKSUM_COMMITS: std::sync::OnceLock<std::sync::Mutex<Vec<PathBuf>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn maybe_fail_registry_commit_for_test(path: &Path) -> Result<()> {
    let paths = FAIL_REGISTRY_CHECKSUM_COMMITS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let mut paths = paths.lock().expect("registry commit failure lock");
    if let Some(index) = paths.iter().position(|candidate| candidate == path) {
        paths.remove(index);
        return Err(msg("injected registry checksum commit failure"));
    }
    Ok(())
}

#[cfg(test)]
fn fail_next_registry_checksum_commit_for_test(path: &Path) {
    FAIL_REGISTRY_CHECKSUM_COMMITS
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
        .expect("registry commit failure lock")
        .push(path.to_path_buf());
}
pub fn load_cached_registry(paths: &MasonPaths) -> Result<RegistryCache> {
    let _lock = RegistryCacheLock::acquire_shared(paths)?;
    let index = paths.registry_index_file();
    let checksum_path = paths.registry_checksum_file();
    if !index.exists() {
        return Err(M4aError::RegistryCacheMissing);
    }
    let bytes = fs::read(&index)?;
    if checksum_path.exists() {
        let expected = fs::read_to_string(checksum_path)?.trim().to_owned();
        let actual = hex::encode(Sha256::digest(&bytes));
        if expected != actual {
            return Err(M4aError::RegistryChecksumMismatch);
        }
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn load_or_refresh(paths: &MasonPaths, source: Option<&str>) -> Result<RegistryCache> {
    let progress = NoProgressSink;
    load_or_refresh_with_progress(paths, source, &progress)
}

pub fn load_or_refresh_with_progress(
    paths: &MasonPaths,
    source: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<RegistryCache> {
    if let Some(source) = source {
        refresh_registry_with_progress(paths, Some(source), progress)?;
        load_cached_registry(paths)
    } else {
        match load_cached_registry(paths) {
            Ok(cache) => Ok(cache),
            Err(M4aError::RegistryCacheMissing) => {
                progress.event(
                    "refresh",
                    "registry",
                    ProgressStatus::Running,
                    None,
                    "registry cache missing; refreshing",
                );
                refresh_registry_with_progress(paths, None, progress)?;
                load_cached_registry(paths)
            }
            Err(err) => Err(err),
        }
    }
}

pub fn search_packages(
    cache: &RegistryCache,
    installed: &InstalledState,
    platform: &Platform,
    query: Option<&str>,
    category: Option<&str>,
    language: Option<&str>,
) -> Vec<PackageSummary> {
    let query = query.map(|q| q.to_ascii_lowercase());
    let category = category.map(|c| c.to_ascii_lowercase());
    let language = language.map(|l| l.to_ascii_lowercase());
    let mut summaries = Vec::new();
    for raw in cache.packages.values() {
        if let Some(q) = &query {
            let haystack = format!(
                "{} {}",
                raw.name,
                raw.description.clone().unwrap_or_default()
            )
            .to_ascii_lowercase();
            if !haystack.contains(q) {
                continue;
            }
        }
        if let Some(cat) = &category {
            if !raw
                .categories
                .iter()
                .any(|c| c.to_ascii_lowercase() == *cat)
            {
                continue;
            }
        }
        if let Some(lang) = &language {
            if !raw
                .languages
                .iter()
                .any(|l| l.to_ascii_lowercase() == *lang)
            {
                continue;
            }
        }
        summaries.push(summary_for(raw, installed, platform));
    }
    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    summaries
}

pub fn summary_for(
    raw: &RawPackageSpec,
    installed: &InstalledState,
    platform: &Platform,
) -> PackageSummary {
    let normalized = raw.normalize(platform, None).ok();
    let installed_pkg = installed.packages.get(&raw.name);
    let version = normalized.as_ref().map(|p| p.version.clone());
    let (requires_build_scripts, build_scripts, extra_packages) = normalized
        .as_ref()
        .map(|p| {
            let build_scripts = p.source.build_scripts.clone();
            (
                !build_scripts.is_empty(),
                build_scripts,
                p.source.extra_packages.clone(),
            )
        })
        .unwrap_or_else(|| (false, Vec::new(), Vec::new()));
    let outdated = match (installed_pkg, version.as_deref()) {
        (Some(inst), Some(latest)) => inst.version != latest,
        _ => false,
    };
    PackageSummary {
        name: raw.name.clone(),
        description: raw.description.clone(),
        version,
        languages: raw.languages.clone(),
        categories: raw.categories.clone(),
        installed: installed_pkg.is_some(),
        installed_version: installed_pkg.map(|p| p.version.clone()),
        outdated,
        deprecated: raw.deprecated,
        neovim_lspconfig: raw.neovim.as_ref().and_then(|n| n.lspconfig.clone()),
        requires_build_scripts,
        build_scripts,
        extra_packages,
    }
}

pub fn normalize_package(
    cache: &RegistryCache,
    name: &str,
    requested_version: Option<&str>,
    platform: &Platform,
) -> Result<NormalizedPackage> {
    let raw = cache
        .packages
        .get(name)
        .ok_or_else(|| M4aError::PackageNotFound(name.to_owned()))?;
    raw.normalize(platform, requested_version)
}

pub fn load_registry_source(source: &str) -> Result<BTreeMap<String, RawPackageSpec>> {
    let progress = NoProgressSink;
    load_registry_source_with_progress(source, &progress)
}

pub fn load_registry_source_with_progress(
    source: &str,
    progress: &dyn ProgressSink,
) -> Result<BTreeMap<String, RawPackageSpec>> {
    if let Some(path) = local_path(source) {
        return load_registry_path(path);
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        let bytes = fetch_bytes_with_progress(source, "refresh", None, progress)?;
        if source.ends_with(".zip") || source.contains("github.com") {
            return load_registry_zip(Cursor::new(bytes));
        }
        return load_registry_json_or_yaml(&bytes, source);
    }
    let path = Path::new(source);
    if path.exists() {
        load_registry_path(path)
    } else {
        Err(msg(format!("unsupported registry source: {source}")))
    }
}

fn load_registry_path(path: &Path) -> Result<BTreeMap<String, RawPackageSpec>> {
    if path.is_dir() {
        return load_registry_dir(path);
    }
    let bytes = fs::read(path)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        return load_registry_zip(Cursor::new(bytes));
    }
    load_registry_json_or_yaml(&bytes, &path.display().to_string())
}

fn load_registry_dir(path: &Path) -> Result<BTreeMap<String, RawPackageSpec>> {
    let packages_root = if path.join("packages").is_dir() {
        path.join("packages")
    } else {
        path.to_path_buf()
    };
    let mut packages = BTreeMap::new();
    for entry in WalkDir::new(packages_root).min_depth(1).max_depth(3) {
        let entry = entry.map_err(|err| msg(err.to_string()))?;
        if entry.file_type().is_file() && entry.file_name() == "package.yaml" {
            let bytes = fs::read(entry.path())?;
            let spec: RawPackageSpec = serde_yaml::from_slice(&bytes)?;
            packages.insert(spec.name.clone(), spec);
        }
    }
    if packages.is_empty() {
        return Err(msg(format!(
            "registry directory contains no package.yaml files: {}",
            path.display()
        )));
    }
    Ok(packages)
}

fn load_registry_zip<R: Read + std::io::Seek>(
    reader: R,
) -> Result<BTreeMap<String, RawPackageSpec>> {
    let mut zip = zip::ZipArchive::new(reader)?;
    let mut packages = BTreeMap::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        if !file.name().ends_with("/package.yaml") || !file.name().contains("/packages/") {
            continue;
        }
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        let spec: RawPackageSpec = serde_yaml::from_str(&text)?;
        packages.insert(spec.name.clone(), spec);
    }
    if packages.is_empty() {
        return Err(msg("registry zip contains no package definitions"));
    }
    Ok(packages)
}

fn load_registry_json_or_yaml(
    bytes: &[u8],
    source: &str,
) -> Result<BTreeMap<String, RawPackageSpec>> {
    if source.ends_with(".json") {
        if let Ok(cache) = serde_json::from_slice::<RegistryCache>(bytes) {
            return Ok(cache.packages);
        }
        let list: Vec<RawPackageSpec> = serde_json::from_slice(bytes)?;
        return Ok(list.into_iter().map(|p| (p.name.clone(), p)).collect());
    }
    let spec: RawPackageSpec = serde_yaml::from_slice(bytes)?;
    Ok(BTreeMap::from([(spec.name.clone(), spec)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::MasonPaths;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io::Write;
    use zip::write::FileOptions;

    fn paths(root: &Path) -> MasonPaths {
        let mut env = HashMap::new();
        env.insert("HOME".to_owned(), OsString::from(root));
        env.insert(
            "MASON4AGENTS_CACHE_HOME".to_owned(),
            OsString::from(root.join("cache")),
        );
        env.insert(
            "MASON4AGENTS_DATA_HOME".to_owned(),
            OsString::from(root.join("data")),
        );
        MasonPaths::from_getter(|key| env.get(key).cloned()).unwrap()
    }

    fn write_registry_with_version(root: &Path, version: &str) -> PathBuf {
        let dir = root.join("registry/packages/demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.yaml"),
            format!(
                r#"
name: demo
description: Demo package
languages: [Rust]
categories: [Formatter]
source:
  id: pkg:generic/acme/demo@{version}
bin:
  demo: demo
"#
            ),
        )
        .unwrap();
        root.join("registry")
    }

    fn write_registry(root: &Path) -> PathBuf {
        write_registry_with_version(root, "1.0.0")
    }

    #[test]
    fn refreshes_file_registry_and_loads_cache_with_checksum() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let registry = write_registry(tmp.path());
        let summary = refresh_registry(&paths, Some(registry.to_str().unwrap())).unwrap();
        assert_eq!(summary.package_count, 1);
        let loaded = load_cached_registry(&paths).unwrap();
        assert!(loaded.packages.contains_key("demo"));
        fs::write(paths.registry_index_file(), b"{}").unwrap();
        assert!(matches!(
            load_cached_registry(&paths).unwrap_err(),
            M4aError::RegistryChecksumMismatch
        ));
    }

    #[test]
    fn refresh_rolls_back_if_checksum_commit_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let registry = write_registry_with_version(tmp.path(), "1.0.0");
        let source = registry.to_str().unwrap();

        refresh_registry(&paths, Some(source)).unwrap();
        write_registry_with_version(tmp.path(), "2.0.0");
        fail_next_registry_checksum_commit_for_test(&paths.registry_checksum_file());

        let err = refresh_registry(&paths, Some(source)).unwrap_err();
        assert_eq!(err.to_string(), "injected registry checksum commit failure");

        let loaded = load_cached_registry(&paths).unwrap();
        assert_eq!(
            loaded.packages.get("demo").unwrap().source.id,
            "pkg:generic/acme/demo@1.0.0"
        );
        let checksum = fs::read_to_string(paths.registry_checksum_file()).unwrap();
        let bytes = fs::read(paths.registry_index_file()).unwrap();
        assert_eq!(checksum.trim(), hex::encode(Sha256::digest(&bytes)));
    }
    #[test]
    fn load_or_refresh_uses_cache_unless_source_is_explicit() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let registry = write_registry(tmp.path());
        let source = registry.to_str().unwrap();
        refresh_registry(&paths, Some(source)).unwrap();

        fs::write(
            registry.join("packages/demo/package.yaml"),
            r#"
name: demo
description: Demo package
languages: [Rust]
categories: [Formatter]
source:
  id: pkg:generic/acme/demo@2.0.0
bin:
  demo: demo
"#,
        )
        .unwrap();

        let cached = load_or_refresh(&paths, None).unwrap();
        assert_eq!(
            cached.packages.get("demo").unwrap().source.id,
            "pkg:generic/acme/demo@1.0.0"
        );

        let refreshed = load_or_refresh(&paths, Some(source)).unwrap();
        assert_eq!(
            refreshed.packages.get("demo").unwrap().source.id,
            "pkg:generic/acme/demo@2.0.0"
        );
    }

    #[test]
    fn loads_registry_zip_and_searches_filters() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("registry.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file(
                "mason-registry-main/packages/demo/package.yaml",
                FileOptions::<()>::default(),
            )
            .unwrap();
            zip.write_all(
                br#"
name: demo
description: Demo package
languages: [Rust]
categories: [Formatter]
source:
  id: pkg:generic/acme/demo@1.0.0
bin:
  demo: demo
"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let packages = load_registry_source(zip_path.to_str().unwrap()).unwrap();
        let state = InstalledState::default();
        let result = search_packages(
            &RegistryCache {
                refreshed_at: Utc::now(),
                source: "zip".to_owned(),
                packages,
            },
            &state,
            &Platform::new("linux", "x64", Some("gnu")),
            Some("demo"),
            Some("formatter"),
            Some("rust"),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn package_summary_includes_build_metadata() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: scripted
description: Scripted package
languages: [Rust]
categories: [Formatter]
source:
  id: pkg:generic/acme/scripted@1.0.0
  extra_packages:
    - left-pad
    - npm-run-all
  build:
    run:
      - npm install
      - npm run build
bin:
  scripted: scripted
"#,
        )
        .unwrap();

        let summary = summary_for(
            &raw,
            &InstalledState::default(),
            &Platform::new("linux", "x64", Some("gnu")),
        );

        assert!(summary.requires_build_scripts);
        assert_eq!(summary.build_scripts, vec!["npm install", "npm run build"]);
        assert_eq!(summary.extra_packages, vec!["left-pad", "npm-run-all"]);

        let value = serde_json::to_value(&summary).unwrap();
        assert_eq!(value["requires_build_scripts"], true);
        assert_eq!(
            value["build_scripts"],
            serde_json::json!(["npm install", "npm run build"])
        );
        assert_eq!(
            value["extra_packages"],
            serde_json::json!(["left-pad", "npm-run-all"])
        );
    }

    #[test]
    fn package_summary_deserializes_without_build_metadata() {
        let summary: PackageSummary = serde_json::from_value(serde_json::json!({
            "name": "stylua",
            "description": null,
            "version": "v1.0.0",
            "languages": [],
            "categories": [],
            "installed": false,
            "installed_version": null,
            "outdated": false,
            "deprecated": false,
            "neovim_lspconfig": null
        }))
        .unwrap();

        assert!(!summary.requires_build_scripts);
        assert!(summary.build_scripts.is_empty());
        assert!(summary.extra_packages.is_empty());
    }
    #[test]
    fn corrupt_registry_json_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("bad.json");
        fs::write(&file, b"not json").unwrap();
        assert!(load_registry_source(file.to_str().unwrap()).is_err());
    }
}
