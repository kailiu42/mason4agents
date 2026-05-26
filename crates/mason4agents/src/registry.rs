use crate::download::{fetch_bytes_with_progress, local_path};
use crate::package_spec::{NormalizedPackage, RawPackageSpec};
use crate::paths::MasonPaths;
use crate::platform::Platform;
use crate::progress::{emit_error, NoProgressSink, ProgressSink, ProgressStatus};
use crate::store::InstalledState;
use crate::types::{msg, M4aError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefreshSummary {
    pub source: String,
    pub package_count: usize,
    pub cache_file: PathBuf,
    pub checksum: String,
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
        fs::create_dir_all(&paths.registry_dir)?;
        fs::write(paths.registry_index_file(), &bytes)?;
        fs::write(paths.registry_checksum_file(), checksum.as_bytes())?;
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

pub fn load_cached_registry(paths: &MasonPaths) -> Result<RegistryCache> {
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

    fn write_registry(root: &Path) -> PathBuf {
        let dir = root.join("registry/packages/demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.yaml"),
            r#"
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
        root.join("registry")
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
    fn corrupt_registry_json_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("bad.json");
        fs::write(&file, b"not json").unwrap();
        assert!(load_registry_source(file.to_str().unwrap()).is_err());
    }
}
