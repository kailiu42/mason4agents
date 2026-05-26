use crate::download::fetch_bytes;
use crate::paths::MasonPaths;
use crate::platform::Platform;
use crate::registry::{summary_for, PackageSummary, RegistryCache};
use crate::store::InstalledState;
use crate::{M4aError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

const CURATED_SCHEMA_VERSION: u32 = 2;
const CURATED_SOURCE: &str = "lazyvim-extras-lang";
const CURATED_CACHE_DIR: &str = "suggestions";
const CURATED_CACHE_FILE: &str = "lazyvim-curated.json";
const OMP_DEFAULT_LSP_CACHE_FILE: &str = "omp-default-lsp.json";
const MAX_SCANNED_ENTRIES: usize = 4096;
const MAX_SCAN_DEPTH: usize = 5;

const LAZYVIM_SOURCES: &[LazyVimSource] = &[
    LazyVimSource {
        signal: "rust",
        url: "https://raw.githubusercontent.com/LazyVim/LazyVim/main/lua/lazyvim/plugins/extras/lang/rust.lua",
        fallback_packages: &["rust-analyzer"],
    },
    LazyVimSource {
        signal: "go",
        url: "https://raw.githubusercontent.com/LazyVim/LazyVim/main/lua/lazyvim/plugins/extras/lang/go.lua",
        fallback_packages: &["gopls", "goimports", "gofumpt", "golangci-lint"],
    },
    LazyVimSource {
        signal: "python",
        url: "https://raw.githubusercontent.com/LazyVim/LazyVim/main/lua/lazyvim/plugins/extras/lang/python.lua",
        fallback_packages: &["pyright", "ruff"],
    },
    LazyVimSource {
        signal: "typescript",
        url: "https://raw.githubusercontent.com/LazyVim/LazyVim/main/lua/lazyvim/plugins/extras/lang/typescript/init.lua",
        fallback_packages: &["typescript-language-server"],
    },
    LazyVimSource {
        signal: "typescript",
        url: "https://raw.githubusercontent.com/LazyVim/LazyVim/main/lua/lazyvim/plugins/extras/lang/typescript/vtsls.lua",
        fallback_packages: &["typescript-language-server"],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SuggestionItem {
    #[serde(flatten)]
    pub package: PackageSummary,
    pub reason: String,
    pub signals: Vec<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LazyVimCuratedCache {
    pub schema_version: u32,
    pub source: String,
    pub source_ref: Option<String>,
    pub fetched_at: DateTime<Utc>,
    pub rules: Vec<CuratedRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CuratedRule {
    pub signal: String,
    pub reason: String,
    pub packages: Vec<CuratedPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CuratedPackage {
    pub package: String,
    pub capability: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SuggestionOptions<'a> {
    pub project_path: &'a Path,
    pub refresh_curated: bool,
    pub curated_source: Option<&'a str>,
}

#[derive(Debug)]
struct LazyVimSource {
    signal: &'static str,
    url: &'static str,
    fallback_packages: &'static [&'static str],
}

#[derive(Debug, Default)]
struct ProjectSignals {
    keys: BTreeSet<String>,
    descriptions: BTreeMap<String, String>,
}

pub fn suggest_packages(
    paths: &MasonPaths,
    cache: &RegistryCache,
    installed: &InstalledState,
    platform: &Platform,
    options: SuggestionOptions<'_>,
) -> Result<Vec<SuggestionItem>> {
    let signals = detect_project_signals(options.project_path)?;
    if signals.keys.is_empty() {
        return Ok(Vec::new());
    }

    let curated_sources =
        load_curated_sources(paths, options.refresh_curated, options.curated_source)?;
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();

    for curated in &curated_sources {
        for rule in &curated.rules {
            if !signals.keys.contains(&rule.signal) {
                continue;
            }
            for package_rule in &rule.packages {
                if !seen.insert(package_rule.package.clone()) {
                    continue;
                }
                let Some(raw) = cache.packages.get(&package_rule.package) else {
                    continue;
                };
                if raw.normalize(platform, None).is_err() {
                    continue;
                }
                let reason = signals
                    .descriptions
                    .get(&rule.signal)
                    .map(|signal| {
                        format!(
                            "{}; {} via {}",
                            signal, package_rule.capability, rule.reason
                        )
                    })
                    .unwrap_or_else(|| format!("{} via {}", package_rule.capability, rule.reason));
                items.push(SuggestionItem {
                    package: summary_for(raw, installed, platform),
                    reason,
                    signals: vec![rule.signal.clone()],
                    source: curated.source.clone(),
                });
            }
        }
    }

    Ok(items)
}

pub fn curated_cache_path(paths: &MasonPaths) -> PathBuf {
    paths
        .cache_dir
        .join(CURATED_CACHE_DIR)
        .join(CURATED_CACHE_FILE)
}

fn omp_default_lsp_cache_path(paths: &MasonPaths) -> PathBuf {
    paths
        .cache_dir
        .join(CURATED_CACHE_DIR)
        .join(OMP_DEFAULT_LSP_CACHE_FILE)
}

pub fn refresh_curated_cache(
    paths: &MasonPaths,
    source: Option<&str>,
) -> Result<LazyVimCuratedCache> {
    match fetch_curated(source) {
        Ok(curated) => {
            write_curated_cache(paths, &curated)?;
            Ok(curated)
        }
        Err(err) => match read_optional_curated_cache(curated_cache_path(paths))? {
            Some(stale) => Ok(stale),
            None => match err {
                M4aError::Http(_) | M4aError::Io(_) | M4aError::Json(_) | M4aError::Yaml(_) => {
                    Ok(builtin_curated())
                }
                other => Err(other),
            },
        },
    }
}

fn load_curated_sources(
    paths: &MasonPaths,
    refresh: bool,
    source: Option<&str>,
) -> Result<Vec<LazyVimCuratedCache>> {
    let mut curated = Vec::new();
    if let Some(omp_defaults) = read_optional_curated_cache(omp_default_lsp_cache_path(paths))? {
        curated.push(omp_defaults);
    }
    curated.push(load_lazyvim_curated(paths, refresh, source)?);
    Ok(curated)
}

fn load_lazyvim_curated(
    paths: &MasonPaths,
    refresh: bool,
    source: Option<&str>,
) -> Result<LazyVimCuratedCache> {
    if refresh {
        return refresh_curated_cache(paths, source);
    }
    Ok(read_optional_curated_cache(curated_cache_path(paths))?.unwrap_or_else(builtin_curated))
}

fn read_optional_curated_cache(path: PathBuf) -> Result<Option<LazyVimCuratedCache>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let Ok(curated) = serde_json::from_slice::<LazyVimCuratedCache>(&bytes) else {
        return Ok(None);
    };
    if curated.schema_version == CURATED_SCHEMA_VERSION {
        Ok(Some(normalize_curated(curated)))
    } else {
        Ok(None)
    }
}

fn write_curated_cache(paths: &MasonPaths, curated: &LazyVimCuratedCache) -> Result<()> {
    let path = curated_cache_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(curated)?)?;
    Ok(())
}

fn fetch_curated(source: Option<&str>) -> Result<LazyVimCuratedCache> {
    if let Some(source) = source {
        let bytes = fetch_bytes(source)?;
        let mut curated: LazyVimCuratedCache = serde_json::from_slice(&bytes)?;
        curated = normalize_curated(curated);
        curated.schema_version = CURATED_SCHEMA_VERSION;
        if curated.source_ref.is_none() {
            curated.source_ref = Some(source.to_owned());
        }
        return Ok(curated);
    }

    let mut rules_by_signal = BTreeMap::<String, BTreeSet<String>>::new();
    let mut fetched_urls = Vec::new();
    for lazy_source in LAZYVIM_SOURCES {
        let bytes = fetch_bytes(lazy_source.url)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut packages = parse_lazyvim_packages(&text);
        if packages.is_empty() {
            packages.extend(
                lazy_source
                    .fallback_packages
                    .iter()
                    .map(|p| (*p).to_owned()),
            );
        }
        if packages.is_empty() {
            continue;
        }
        fetched_urls.push(lazy_source.url.to_owned());
        rules_by_signal
            .entry(lazy_source.signal.to_owned())
            .or_default()
            .extend(packages);
    }

    if rules_by_signal.is_empty() {
        return Ok(builtin_curated());
    }

    let mut rules = builtin_curated()
        .rules
        .into_iter()
        .filter(|rule| !rules_by_signal.contains_key(&rule.signal))
        .collect::<Vec<_>>();
    for (signal, packages) in rules_by_signal {
        rules.push(CuratedRule {
            reason: "LazyVim extras/lang curated list".to_owned(),
            packages: packages
                .into_iter()
                .map(|package| CuratedPackage {
                    capability: capability_for_package(&package).to_owned(),
                    package,
                })
                .collect(),
            signal,
        });
    }
    rules.sort_by_key(|rule| rule_order(&rule.signal));

    Ok(normalize_curated(LazyVimCuratedCache {
        schema_version: CURATED_SCHEMA_VERSION,
        source: CURATED_SOURCE.to_owned(),
        source_ref: Some(fetched_urls.join(",")),
        fetched_at: Utc::now(),
        rules,
    }))
}

fn normalize_curated(mut curated: LazyVimCuratedCache) -> LazyVimCuratedCache {
    for rule in &mut curated.rules {
        normalize_rule_packages(&mut rule.packages);
    }
    curated
}

fn normalize_rule_packages(packages: &mut Vec<CuratedPackage>) {
    let mut seen = BTreeSet::new();
    packages.retain_mut(|package| {
        if package.package == "vtsls" {
            package.package = "typescript-language-server".to_owned();
        }
        seen.insert(package.package.clone())
    });
}

fn parse_lazyvim_packages(text: &str) -> BTreeSet<String> {
    let mut packages = BTreeSet::new();
    for (needle, package) in [
        ("rust_analyzer", "rust-analyzer"),
        ("gopls", "gopls"),
        ("pyright", "pyright"),
        ("ruff", "ruff"),
        ("vtsls", "typescript-language-server"),
    ] {
        if text.contains(needle) {
            packages.insert(package.to_owned());
        }
    }

    let mut rest = text;
    while let Some(start) = rest.find("ensure_installed") {
        rest = &rest[start + "ensure_installed".len()..];
        let Some(open) = rest.find('{') else {
            break;
        };
        rest = &rest[open + 1..];
        let Some(close) = rest.find('}') else {
            break;
        };
        for token in quoted_tokens(&rest[..close]) {
            if is_mason_package_id(&token) {
                packages.insert(token);
            }
        }
        rest = &rest[close + 1..];
    }

    packages
}

fn quoted_tokens(mut text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    while let Some(start) = text.find(['\'', '"']) {
        let quote = text.as_bytes()[start] as char;
        text = &text[start + 1..];
        let Some(end) = text.find(quote) else {
            break;
        };
        tokens.push(text[..end].to_owned());
        text = &text[end + 1..];
    }
    tokens
}

fn is_mason_package_id(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn detect_project_signals(root: &Path) -> Result<ProjectSignals> {
    let mut signals = ProjectSignals::default();
    let walker = WalkDir::new(root)
        .max_depth(MAX_SCAN_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_ignored_dir(entry));

    for entry in walker.take(MAX_SCANNED_ENTRIES) {
        let entry = entry.map_err(|err| {
            M4aError::Message(format!("project scan failed for {}: {err}", root.display()))
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        classify_path(entry.path(), &mut signals);
    }
    Ok(signals)
}

fn classify_path(path: &Path, signals: &mut ProjectSignals) {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let lower_name = file_name.to_ascii_lowercase();
    match lower_name.as_str() {
        "cargo.toml" => signals.insert("rust", "Cargo.toml detected"),
        "go.mod" => signals.insert("go", "go.mod detected"),
        "pyproject.toml" | "requirements.txt" | "setup.py" | "setup.cfg" | "tox.ini" => {
            signals.insert("python", "Python project marker detected")
        }
        "tsconfig.json" => signals.insert("typescript", "tsconfig.json detected"),
        "package.json" => signals.insert("typescript", "package.json detected"),
        "biome.json" | "biome.jsonc" => {
            signals.insert(
                "typescript",
                "JavaScript/TypeScript project marker detected",
            );
            signals.insert("typescript:biome", "Biome configuration detected");
        }
        "eslint.config.js" | "eslint.config.mjs" | "eslint.config.cjs" | "eslint.config.ts" => {
            signals.insert(
                "typescript",
                "JavaScript/TypeScript project marker detected",
            );
            signals.insert("typescript:eslint", "ESLint configuration detected");
        }
        "prettier.config.js"
        | "prettier.config.mjs"
        | "prettier.config.cjs"
        | ".prettierrc"
        | ".prettierrc.json"
        | ".prettierrc.yaml"
        | ".prettierrc.yml" => {
            signals.insert(
                "typescript",
                "JavaScript/TypeScript project marker detected",
            );
            signals.insert("typescript:prettier", "Prettier configuration detected");
        }
        "stylua.toml" | ".stylua.toml" | ".luarc.json" | ".luarc.jsonc" => {
            signals.insert("lua", "Lua configuration detected");
        }
        "dockerfile" => signals.insert("docker", "Dockerfile detected"),
        "ruff.toml" => signals.insert("python", "Ruff/Python configuration detected"),
        _ => {
            if lower_name.ends_with(".dockerfile") {
                signals.insert("docker", "Dockerfile detected");
            }
        }
    }

    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
    {
        Some(ext) if ext == "rs" => signals.insert("rust", "Rust source files detected"),
        Some(ext) if ext == "go" => signals.insert("go", "Go source files detected"),
        Some(ext) if ext == "py" => signals.insert("python", "Python source files detected"),
        Some(ext) if matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => {
            signals.insert("typescript", "JavaScript/TypeScript source files detected")
        }
        Some(ext) if ext == "lua" => signals.insert("lua", "Lua source files detected"),
        Some(ext) if matches!(ext.as_str(), "sh" | "bash" | "zsh") => {
            signals.insert("shell", "Shell scripts detected")
        }
        Some(ext) if matches!(ext.as_str(), "tf" | "tfvars") => {
            signals.insert("terraform", "Terraform files detected")
        }
        Some(ext) if matches!(ext.as_str(), "yaml" | "yml") => {
            signals.insert("yaml", "YAML files detected")
        }
        Some(ext) if matches!(ext.as_str(), "md" | "mdx") => {
            signals.insert("markdown", "Markdown files detected")
        }
        _ => {}
    }
}

impl ProjectSignals {
    fn insert(&mut self, key: &str, description: &str) {
        self.keys.insert(key.to_owned());
        self.descriptions
            .entry(key.to_owned())
            .or_insert_with(|| description.to_owned());
    }
}

fn is_ignored_dir(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    matches!(
        name.as_ref(),
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | ".venv"
            | "venv"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
    )
}

fn builtin_curated() -> LazyVimCuratedCache {
    LazyVimCuratedCache {
        schema_version: CURATED_SCHEMA_VERSION,
        source: format!("{CURATED_SOURCE}:builtin"),
        source_ref: Some("LazyVim extras/lang normalized snapshot".to_owned()),
        fetched_at: DateTime::<Utc>::from(std::time::UNIX_EPOCH),
        rules: vec![
            rule(
                "typescript:biome",
                "project config override",
                &[pkg("biome", "Formatter/Linter")],
            ),
            rule(
                "typescript:eslint",
                "project config override",
                &[pkg("eslint-lsp", "Linter")],
            ),
            rule(
                "typescript:prettier",
                "project config override",
                &[pkg("prettier", "Formatter")],
            ),
            rule(
                "rust",
                "LazyVim extras/lang/rust.lua",
                &[pkg("rust-analyzer", "LSP")],
            ),
            rule(
                "go",
                "LazyVim extras/lang/go.lua",
                &[
                    pkg("gopls", "LSP"),
                    pkg("goimports", "Formatter"),
                    pkg("gofumpt", "Formatter"),
                    pkg("golangci-lint", "Linter"),
                ],
            ),
            rule(
                "python",
                "LazyVim extras/lang/python.lua",
                &[pkg("pyright", "LSP"), pkg("ruff", "Linter/Formatter")],
            ),
            rule(
                "typescript",
                "LazyVim extras/lang/typescript",
                &[pkg("typescript-language-server", "LSP")],
            ),
            rule(
                "lua",
                "LazyVim extras/lang/lua.lua",
                &[
                    pkg("lua-language-server", "LSP"),
                    pkg("stylua", "Formatter"),
                ],
            ),
            rule(
                "shell",
                "LazyVim shell tooling conventions",
                &[
                    pkg("bash-language-server", "LSP"),
                    pkg("shellcheck", "Linter"),
                    pkg("shfmt", "Formatter"),
                ],
            ),
            rule(
                "docker",
                "LazyVim Docker tooling conventions",
                &[
                    pkg("dockerfile-language-server", "LSP"),
                    pkg("hadolint", "Linter"),
                ],
            ),
            rule(
                "terraform",
                "LazyVim Terraform tooling conventions",
                &[pkg("terraform-ls", "LSP"), pkg("tflint", "Linter")],
            ),
            rule(
                "yaml",
                "LazyVim YAML tooling conventions",
                &[
                    pkg("yaml-language-server", "LSP"),
                    pkg("yamlfmt", "Formatter"),
                ],
            ),
            rule(
                "markdown",
                "LazyVim Markdown tooling conventions",
                &[pkg("marksman", "LSP"), pkg("markdownlint-cli2", "Linter")],
            ),
        ],
    }
}

fn rule(signal: &str, reason: &str, packages: &[CuratedPackage]) -> CuratedRule {
    CuratedRule {
        signal: signal.to_owned(),
        reason: reason.to_owned(),
        packages: packages.to_vec(),
    }
}

fn pkg(package: &str, capability: &str) -> CuratedPackage {
    CuratedPackage {
        package: package.to_owned(),
        capability: capability.to_owned(),
    }
}

fn rule_order(signal: &str) -> usize {
    match signal {
        "typescript:biome" => 0,
        "typescript:eslint" => 1,
        "typescript:prettier" => 2,
        "rust" => 10,
        "go" => 20,
        "python" => 30,
        "typescript" => 40,
        "lua" => 50,
        "shell" => 60,
        "docker" => 70,
        "terraform" => 80,
        "yaml" => 90,
        "markdown" => 100,
        _ => 1000,
    }
}

fn capability_for_package(package: &str) -> &'static str {
    match package {
        "rust-analyzer"
        | "gopls"
        | "pyright"
        | "vtsls"
        | "typescript-language-server"
        | "lua-language-server"
        | "bash-language-server"
        | "dockerfile-language-server"
        | "terraform-ls"
        | "yaml-language-server"
        | "marksman" => "LSP",
        "goimports" | "gofumpt" | "prettier" | "stylua" | "shfmt" | "yamlfmt" => "Formatter",
        "golangci-lint" | "eslint-lsp" | "shellcheck" | "hadolint" | "tflint"
        | "markdownlint-cli2" => "Linter",
        "ruff" | "biome" => "Linter/Formatter",
        _ => "Tool",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_spec::{RawPackageSpec, RawSource};
    use crate::store::InstalledPackage;
    use std::collections::BTreeMap;

    fn paths(root: &Path) -> MasonPaths {
        MasonPaths {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            bin_dir: root.join("data/bin"),
            packages_dir: root.join("data/packages"),
            share_dir: root.join("data/share"),
            opt_dir: root.join("data/opt"),
            state_file: root.join("state/installed.json"),
            locks_dir: root.join("state/locks"),
            registry_dir: root.join("cache/registry"),
            downloads_dir: root.join("cache/downloads"),
            logs_dir: root.join("cache/logs"),
        }
    }

    fn package(
        name: &str,
        languages: &[&str],
        categories: &[&str],
        version: &str,
    ) -> RawPackageSpec {
        RawPackageSpec {
            name: name.to_owned(),
            description: Some(format!("{name} fixture")),
            homepage: None,
            licenses: Vec::new(),
            languages: languages.iter().map(|l| (*l).to_owned()).collect(),
            categories: categories.iter().map(|c| (*c).to_owned()).collect(),
            deprecated: false,
            source: RawSource {
                id: format!("pkg:generic/acme/{name}@{version}"),
                asset: None,
                version_overrides: Vec::new(),
                extra_packages: Vec::new(),
                build: None,
                download: None,
                supported_platforms: None,
            },
            bin: BTreeMap::new(),
            share: BTreeMap::new(),
            opt: BTreeMap::new(),
            neovim: None,
        }
    }

    fn registry(packages: &[RawPackageSpec]) -> RegistryCache {
        RegistryCache {
            refreshed_at: Utc::now(),
            source: "fixture".to_owned(),
            packages: packages
                .iter()
                .cloned()
                .map(|pkg| (pkg.name.clone(), pkg))
                .collect(),
        }
    }

    fn names(items: &[SuggestionItem]) -> Vec<String> {
        items.iter().map(|item| item.package.name.clone()).collect()
    }

    #[test]
    fn detects_lazyvim_primary_tools_for_common_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        fs::write(root.join("go.mod"), "module example.com/demo\n").unwrap();
        fs::write(root.join("pyproject.toml"), "[project]\nname = \"demo\"\n").unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();

        let cache = registry(&[
            package("rust-analyzer", &["Rust"], &["LSP"], "1.0.0"),
            package("gopls", &["Go"], &["LSP"], "1.0.0"),
            package("goimports", &["Go"], &["Formatter"], "1.0.0"),
            package("gofumpt", &["Go"], &["Formatter"], "1.0.0"),
            package("golangci-lint", &["Go"], &["Linter"], "1.0.0"),
            package("pyright", &["Python"], &["LSP"], "1.0.0"),
            package("ruff", &["Python"], &["Linter", "Formatter"], "1.0.0"),
            package(
                "typescript-language-server",
                &["TypeScript", "JavaScript"],
                &["LSP"],
                "1.0.0",
            ),
        ]);
        let state = InstalledState::default();
        let items = suggest_packages(
            &paths(tmp.path()),
            &cache,
            &state,
            &Platform::current(),
            SuggestionOptions {
                project_path: &root,
                refresh_curated: false,
                curated_source: None,
            },
        )
        .unwrap();

        assert_eq!(
            names(&items),
            [
                "rust-analyzer",
                "gopls",
                "goimports",
                "gofumpt",
                "golangci-lint",
                "pyright",
                "ruff",
                "typescript-language-server"
            ]
        );
    }

    #[test]
    fn filters_missing_registry_packages_and_marks_installed_outdated() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();

        let cache = registry(&[package("rust-analyzer", &["Rust"], &["LSP"], "2.0.0")]);
        let state = InstalledState {
            packages: BTreeMap::from([(
                "rust-analyzer".to_owned(),
                InstalledPackage {
                    name: "rust-analyzer".to_owned(),
                    version: "1.0.0".to_owned(),
                    source_id: "pkg:generic/acme/rust-analyzer@1.0.0".to_owned(),
                    bins: BTreeMap::new(),
                    share: BTreeMap::new(),
                    opt: BTreeMap::new(),
                    installed_at: Utc::now(),
                },
            )]),
        };

        let items = suggest_packages(
            &paths(tmp.path()),
            &cache,
            &state,
            &Platform::current(),
            SuggestionOptions {
                project_path: &root,
                refresh_curated: false,
                curated_source: None,
            },
        )
        .unwrap();

        assert_eq!(names(&items), ["rust-analyzer"]);
        assert!(items[0].package.installed);
        assert!(items[0].package.outdated);
    }

    #[test]
    fn project_config_rules_are_added_before_generic_language_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("biome.json"), "{}").unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();

        let cache = registry(&[
            package(
                "biome",
                &["JavaScript", "TypeScript"],
                &["Formatter", "Linter"],
                "1.0.0",
            ),
            package(
                "typescript-language-server",
                &["TypeScript"],
                &["LSP"],
                "1.0.0",
            ),
        ]);
        let items = suggest_packages(
            &paths(tmp.path()),
            &cache,
            &InstalledState::default(),
            &Platform::current(),
            SuggestionOptions {
                project_path: &root,
                refresh_curated: false,
                curated_source: None,
            },
        )
        .unwrap();

        assert_eq!(names(&items), ["biome", "typescript-language-server"]);
    }

    #[test]
    fn omp_default_lsp_cache_takes_precedence_over_lazyvim_lsp_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();

        let paths = paths(tmp.path());
        let omp_cache_path = omp_default_lsp_cache_path(&paths);
        fs::create_dir_all(omp_cache_path.parent().unwrap()).unwrap();
        let curated = LazyVimCuratedCache {
            schema_version: CURATED_SCHEMA_VERSION,
            source: "omp-default-lsp".to_owned(),
            source_ref: Some("fixture".to_owned()),
            fetched_at: Utc::now(),
            rules: vec![rule(
                "typescript",
                "OMP built-in defaults (typescript-language-server)",
                &[pkg("typescript-language-server", "LSP")],
            )],
        };
        fs::write(&omp_cache_path, serde_json::to_vec(&curated).unwrap()).unwrap();

        let cache = registry(&[package(
            "typescript-language-server",
            &["TypeScript", "JavaScript"],
            &["LSP"],
            "1.0.0",
        )]);
        let items = suggest_packages(
            &paths,
            &cache,
            &InstalledState::default(),
            &Platform::current(),
            SuggestionOptions {
                project_path: &root,
                refresh_curated: false,
                curated_source: None,
            },
        )
        .unwrap();

        assert_eq!(names(&items), ["typescript-language-server"]);
        assert_eq!(items[0].source, "omp-default-lsp");
    }

    #[test]
    fn curated_cache_hit_is_used_without_refresh() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = paths(tmp.path());
        let cache_path = curated_cache_path(&paths);
        fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        let curated = LazyVimCuratedCache {
            schema_version: CURATED_SCHEMA_VERSION,
            source: "fixture-cache".to_owned(),
            source_ref: Some("cache".to_owned()),
            fetched_at: Utc::now(),
            rules: vec![rule("rust", "cached fixture", &[pkg("cached-rust", "LSP")])],
        };
        fs::write(&cache_path, serde_json::to_vec(&curated).unwrap()).unwrap();

        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
        let registry = registry(&[package("cached-rust", &["Rust"], &["LSP"], "1.0.0")]);
        let items = suggest_packages(
            &paths,
            &registry,
            &InstalledState::default(),
            &Platform::current(),
            SuggestionOptions {
                project_path: &root,
                refresh_curated: false,
                curated_source: None,
            },
        )
        .unwrap();

        assert_eq!(names(&items), ["cached-rust"]);
        assert_eq!(items[0].source, "fixture-cache");
    }

    #[test]
    fn curated_refresh_writes_cache_and_failure_falls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let mason_paths = paths(tmp.path());
        let source_path = tmp.path().join("source.json");
        let source = LazyVimCuratedCache {
            schema_version: CURATED_SCHEMA_VERSION,
            source: "fixture-source".to_owned(),
            source_ref: None,
            fetched_at: Utc::now(),
            rules: vec![rule("rust", "source fixture", &[pkg("source-rust", "LSP")])],
        };
        fs::write(&source_path, serde_json::to_vec(&source).unwrap()).unwrap();

        let refreshed =
            refresh_curated_cache(&mason_paths, Some(source_path.to_str().unwrap())).unwrap();
        assert_eq!(refreshed.source, "fixture-source");
        let cache_path = curated_cache_path(&mason_paths);
        assert!(cache_path.exists());
        let cached: LazyVimCuratedCache =
            serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        assert_eq!(cached.rules[0].packages[0].package, "source-rust");

        let stale =
            refresh_curated_cache(&mason_paths, Some("file:///no/such/lazyvim.json")).unwrap();
        assert_eq!(stale.source, "fixture-source");

        let empty_paths = paths(&tmp.path().join("empty"));
        let fallback =
            refresh_curated_cache(&empty_paths, Some("file:///no/such/lazyvim.json")).unwrap();
        assert!(fallback.source.ends_with(":builtin"));
    }
}
