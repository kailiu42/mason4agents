use crate::expressions::render_template;
use crate::platform::Platform;
use crate::purl::Purl;
use crate::types::{msg, M4aError, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawPackageSpec {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub licenses: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(deserialize_with = "deserialize_deprecated", default)]
    pub deprecated: bool,
    pub source: RawSource,
    #[serde(default)]
    pub bin: BTreeMap<String, String>,
    #[serde(default)]
    pub share: BTreeMap<String, String>,
    #[serde(default)]
    pub opt: BTreeMap<String, String>,
    #[serde(default)]
    pub neovim: Option<RawNeovim>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSource {
    pub id: String,
    #[serde(default)]
    pub asset: Option<serde_yaml::Value>,
    #[serde(default)]
    pub version_overrides: Vec<RawVersionOverride>,
    #[serde(default)]
    pub extra_packages: Vec<String>,
    #[serde(default)]
    pub build: Option<serde_yaml::Value>,
    #[serde(default)]
    pub download: Option<serde_yaml::Value>,
    #[serde(default)]
    pub supported_platforms: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawVersionOverride {
    pub constraint: String,
    pub id: String,
    #[serde(default)]
    pub asset: Option<serde_yaml::Value>,
    #[serde(default)]
    pub extra_packages: Option<Vec<String>>,
    #[serde(default)]
    pub build: Option<serde_yaml::Value>,
    #[serde(default)]
    pub download: Option<serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawNeovim {
    #[serde(default)]
    pub lspconfig: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizedPackage {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub languages: Vec<String>,
    pub categories: Vec<String>,
    pub deprecated: bool,
    pub source: NormalizedSource,
    pub bins: BTreeMap<String, String>,
    pub share: BTreeMap<String, String>,
    pub opt: BTreeMap<String, String>,
    pub neovim_lspconfig: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizedSource {
    pub id: String,
    pub source_type: String,
    pub namespace: Option<String>,
    pub package: String,
    pub version: String,
    pub asset: Option<AssetSpec>,
    pub extra_packages: Vec<String>,
    pub build_scripts: Vec<String>,
    pub qualifiers: BTreeMap<String, String>,
    pub subpath: Option<String>,
    pub build: Option<Value>,
    pub download: Option<DownloadEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct AssetSpec {
    pub target: Option<String>,
    pub file: Option<String>,
    #[serde(default)]
    pub extra_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_names: Vec<String>,
    pub bin: Option<String>,
    #[serde(default)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DownloadEntry {
    pub target: Option<String>,
    pub file: String,
    #[serde(default)]
    pub extra: BTreeMap<String, Value>,
}

impl RawPackageSpec {
    pub fn normalize(
        &self,
        platform: &Platform,
        requested_version: Option<&str>,
    ) -> Result<NormalizedPackage> {
        let selected_source = self.select_source(requested_version)?;
        let mut purl = Purl::parse(&selected_source.id)?;
        if let Some(version) = requested_version {
            purl.version = Some(version.to_owned());
        }
        let version = purl.version.clone().ok_or_else(|| {
            msg(format!(
                "source id for {} must include a version",
                self.name
            ))
        })?;
        let source_id = rebuild_id_with_version(&selected_source.id, &version);
        let mut asset = select_asset(
            &self.name,
            &selected_source.asset,
            platform,
            &version,
            &source_id,
        )?;
        // Check supported_platforms if present
        if let Some(ref supported) = selected_source.supported_platforms {
            let candidates = platform.candidates();
            if !candidates.iter().any(|c| supported.contains(c)) {
                return Err(M4aError::UnsupportedTarget {
                    package: self.name.clone(),
                    targets: supported.clone(),
                });
            }
        }
        let download_selection = selected_source
            .download
            .as_ref()
            .map(|raw| {
                select_download_entry(
                    raw,
                    platform,
                    &self.name,
                    &version,
                    &source_id,
                    asset.as_ref(),
                )
            })
            .transpose()?
            .flatten();
        if let Some(download_asset) = download_selection
            .as_ref()
            .and_then(|selection| selection.asset.as_ref())
        {
            asset = Some(match asset {
                Some(existing) => merge_download_asset_files(existing, download_asset),
                None => download_asset.clone(),
            });
        }
        let download = download_selection.map(|selection| selection.entry);
        let selected_build = select_build(&selected_source.build, platform);
        let build_scripts = extract_build_scripts(selected_build.as_ref(), platform);
        // Build initial context (without source.build) to render the build spec itself.
        let initial_context = context_for(
            &version,
            &source_id,
            asset.as_ref(),
            download.as_ref(),
            None,
        );
        let rendered_build = selected_build
            .as_ref()
            .map(|raw| {
                render_value_deep(
                    &serde_json::to_value(raw).unwrap_or(Value::Null),
                    &initial_context,
                )
            })
            .transpose()?;
        // Now build the full context including the rendered build.
        let context = context_for(
            &version,
            &source_id,
            asset.as_ref(),
            download.as_ref(),
            rendered_build.as_ref(),
        );
        let bins = render_map(&self.bin, &context)?;
        let share = render_map(&self.share, &context)?;
        let opt = render_map(&self.opt, &context)?;
        Ok(NormalizedPackage {
            name: self.name.clone(),
            version: version.clone(),
            description: self.description.clone(),
            languages: self.languages.clone(),
            categories: self.categories.clone(),
            deprecated: self.deprecated,
            source: NormalizedSource {
                id: source_id,
                source_type: purl.ty,
                namespace: purl.namespace,
                package: purl.name,
                version,
                asset,
                extra_packages: selected_source.extra_packages.clone(),
                build_scripts,
                qualifiers: purl.qualifiers,
                subpath: purl.subpath,
                build: rendered_build,
                download,
            },
            bins,
            share,
            opt,
            neovim_lspconfig: self.neovim.as_ref().and_then(|n| n.lspconfig.clone()),
        })
    }

    fn select_source(&self, requested_version: Option<&str>) -> Result<RawSource> {
        let Some(requested) = requested_version else {
            return Ok(self.source.clone());
        };
        let best = self
            .source
            .version_overrides
            .iter()
            .filter(|ov| constraint_matches(&ov.constraint, requested).unwrap_or(false))
            .min_by_key(|ov| constraint_upper_bound(&ov.constraint));
        if let Some(ov) = best {
            let mut selected = self.source.clone();
            selected.id = ov.id.clone();
            if ov.asset.is_some() {
                selected.asset = ov.asset.clone();
            }
            if let Some(ref extra) = ov.extra_packages {
                selected.extra_packages = extra.clone();
            }
            if ov.build.is_some() {
                selected.build = ov.build.clone();
            }
            if ov.download.is_some() {
                selected.download = ov.download.clone();
            }
            return Ok(selected);
        }
        Ok(self.source.clone())
    }
}

fn rebuild_id_with_version(id: &str, version: &str) -> String {
    // Strip qualifiers (?...) and subpath (#...) before replacing version,
    // then re-append them so they are preserved.
    let (without_subpath, subpath) = match id.split_once('#') {
        Some((base, sub)) => (base, Some(format!("#{sub}"))),
        None => (id, None),
    };
    let (without_qualifiers, qualifiers) = match without_subpath.split_once('?') {
        Some((base, qual)) => (base, Some(format!("?{qual}"))),
        None => (without_subpath, None),
    };
    let base = match without_qualifiers.rfind('@') {
        Some(0) | None => format!("{without_qualifiers}@{version}"),
        Some(index) => format!("{}@{version}", &without_qualifiers[..index]),
    };
    let mut result = base;
    if let Some(q) = qualifiers {
        result.push_str(&q);
    }
    if let Some(s) = subpath {
        result.push_str(&s);
    }
    result
}

fn render_map(raw: &BTreeMap<String, String>, context: &Value) -> Result<BTreeMap<String, String>> {
    raw.iter()
        .map(|(key, value)| Ok((key.clone(), render_template(value, context)?)))
        .collect()
}

fn select_build(
    build: &Option<serde_yaml::Value>,
    platform: &Platform,
) -> Option<serde_yaml::Value> {
    let value = build.as_ref()?;
    let serde_yaml::Value::Sequence(seq) = value else {
        return Some(value.clone());
    };
    let has_targets = seq.iter().any(|v| {
        v.as_mapping()
            .and_then(|m| m.get(serde_yaml::Value::String("target".to_owned())))
            .is_some()
    });
    if !has_targets {
        return Some(value.clone());
    }
    let candidates = platform.candidates();
    let target_key = serde_yaml::Value::String("target".to_owned());
    for candidate in candidates {
        for item in seq {
            if let Some(mapping) = item.as_mapping() {
                let raw_target = mapping.get(&target_key);
                let target_matches = match raw_target {
                    Some(serde_yaml::Value::String(s)) => s == candidate.as_str(),
                    Some(serde_yaml::Value::Sequence(arr)) => arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .any(|target| target == candidate.as_str()),
                    _ => false,
                };
                if target_matches {
                    return Some(item.clone());
                }
            }
        }
    }
    seq.iter()
        .find(|item| {
            item.as_mapping()
                .map(|mapping| {
                    !mapping.contains_key(serde_yaml::Value::String("target".to_owned()))
                })
                .unwrap_or(false)
        })
        .cloned()
}

fn extract_build_scripts(build: Option<&serde_yaml::Value>, platform: &Platform) -> Vec<String> {
    let Some(value) = build else {
        return Vec::new();
    };
    let run = match value {
        serde_yaml::Value::Mapping(map) => map
            .get(serde_yaml::Value::String("run".to_owned()))
            .unwrap_or(value),
        other => other,
    };
    if let serde_yaml::Value::Sequence(seq) = run {
        let has_targets = seq.iter().any(|v| {
            v.as_mapping()
                .and_then(|m| m.get(serde_yaml::Value::String("target".to_owned())))
                .is_some()
        });
        if has_targets {
            for candidate in platform.candidates() {
                for item in seq {
                    if let Some(mapping) = item.as_mapping() {
                        let target_key = serde_yaml::Value::String("target".to_owned());
                        let raw_target = mapping.get(&target_key);
                        let target_matches = match raw_target {
                            Some(serde_yaml::Value::String(s)) => s == candidate.as_str(),
                            Some(serde_yaml::Value::Sequence(arr)) => arr
                                .iter()
                                .filter_map(|v| v.as_str())
                                .any(|target| target == candidate.as_str()),
                            _ => false,
                        };
                        if target_matches {
                            if let Some(run_val) =
                                mapping.get(serde_yaml::Value::String("run".to_owned()))
                            {
                                return extract_run_strings(run_val);
                            }
                        }
                    }
                }
            }
            for item in seq {
                if let Some(mapping) = item.as_mapping() {
                    let target_key = serde_yaml::Value::String("target".to_owned());
                    if !mapping.contains_key(&target_key) {
                        if let Some(run_val) =
                            mapping.get(serde_yaml::Value::String("run".to_owned()))
                        {
                            return extract_run_strings(run_val);
                        }
                    }
                }
            }
        }
    }
    extract_run_strings(run)
}

fn extract_run_strings(run: &serde_yaml::Value) -> Vec<String> {
    match run {
        serde_yaml::Value::String(s) => vec![s.clone()],
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}
fn deserialize_deprecated<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<bool, D::Error> {
    use serde::de;
    struct DeprecatedVisitor;
    impl<'de> de::Visitor<'de> for DeprecatedVisitor {
        type Value = bool;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("bool or object")
        }
        fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<bool, E> {
            Ok(v)
        }
        fn visit_map<A: de::MapAccess<'de>>(self, _: A) -> std::result::Result<bool, A::Error> {
            Ok(true)
        }
    }
    d.deserialize_any(DeprecatedVisitor)
}

fn select_asset(
    package: &str,
    raw: &Option<serde_yaml::Value>,
    platform: &Platform,
    version: &str,
    source_id: &str,
) -> Result<Option<AssetSpec>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let json_value = serde_json::to_value(raw)?;
    let mut selected_target: Option<String> = None;
    let mut selected = match json_value {
        Value::Array(items) => {
            let candidates = platform.candidates();
            let mut matched_item = None;
            let mut available = Vec::new();
            for item in &items {
                let target_val = item.get("target");
                let item_targets: Vec<&str> = match target_val {
                    Some(Value::String(s)) => {
                        available.push(s.clone());
                        vec![s.as_str()]
                    }
                    Some(Value::Array(arr)) => {
                        let strs: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
                        available.extend(strs.iter().map(|s| s.to_string()));
                        strs
                    }
                    _ => continue,
                };
                if let Some(candidate) = candidates
                    .iter()
                    .find(|candidate| item_targets.contains(&candidate.as_str()))
                {
                    selected_target = Some(candidate.clone());
                    matched_item = Some(item.clone());
                    break;
                }
            }
            match matched_item {
                Some(item) => item,
                None => {
                    return Err(M4aError::UnsupportedTarget {
                        package: package.to_owned(),
                        targets: available,
                    });
                }
            }
        }
        Value::Object(map) => {
            if let Some(targets) = parse_asset_targets(package, map.get("target"))? {
                let candidates = platform.candidates();
                let Some(candidate) = candidates
                    .iter()
                    .find(|candidate| targets.iter().any(|target| target == *candidate))
                else {
                    return Err(M4aError::UnsupportedTarget {
                        package: package.to_owned(),
                        targets,
                    });
                };
                selected_target = Some(candidate.clone());
            }
            Value::Object(map)
        }
        Value::Null => return Ok(None),
        _ => return Err(msg(format!("invalid source.asset for package {package}"))),
    };
    if let (Some(target), Value::Object(map)) = (&selected_target, &mut selected) {
        map.insert("target".to_owned(), Value::String(target.clone()));
    }
    asset_from_json(selected, version, source_id, None).map(Some)
}

fn parse_asset_targets(package: &str, value: Option<&Value>) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::String(target) => Ok(Some(vec![target.clone()])),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    msg(format!(
                        "invalid source.asset.target for package {package}; expected string or array of strings"
                    ))
                })
            })
            .collect::<Result<Vec<String>>>()
            .map(Some),
        _ => Err(msg(format!(
            "invalid source.asset.target for package {package}; expected string or array of strings"
        ))),
    }
}

fn asset_from_json(
    value: Value,
    version: &str,
    source_id: &str,
    download: Option<&DownloadEntry>,
) -> Result<AssetSpec> {
    let Value::Object(map) = value else {
        return Err(msg("asset must be an object"));
    };
    // Parse file: can be a string or an array of strings.
    let (file, extra_files) = match map.get("file") {
        Some(Value::String(s)) => (Some(s.clone()), Vec::new()),
        Some(Value::Array(arr)) => {
            let files: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            let primary = files.first().cloned();
            let rest: Vec<String> = files.into_iter().skip(1).collect();
            (primary, rest)
        }
        _ => (None, Vec::new()),
    };
    let file_names = match map.get("file_names") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    };
    let preliminary = AssetSpec {
        target: map.get("target").and_then(Value::as_str).map(str::to_owned),
        file,
        extra_files,
        file_names,
        bin: map.get("bin").and_then(Value::as_str).map(str::to_owned),
        extra: map
            .iter()
            .filter(|(k, _)| *k != "target" && *k != "file" && *k != "file_names" && *k != "bin")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    };
    let context = context_for(version, source_id, Some(&preliminary), download, None);
    let mut rendered = preliminary.clone();
    rendered.file = match rendered.file.as_deref() {
        Some(s) => Some(render_template(s, &context)?),
        None => None,
    };
    rendered.extra_files = rendered
        .extra_files
        .iter()
        .map(|f| render_template(f, &context))
        .collect::<Result<Vec<String>>>()?;
    rendered.file_names = rendered
        .file_names
        .iter()
        .map(|f| render_template(f, &context))
        .collect::<Result<Vec<String>>>()?;
    rendered.bin = match rendered.bin.as_deref() {
        Some(s) => Some(render_template(s, &context)?),
        None => None,
    };
    let context = context_for(version, source_id, Some(&rendered), download, None);
    if let Some(file) = rendered.file.as_deref() {
        rendered.file = Some(render_template(file, &context)?);
    }
    rendered.extra_files = rendered
        .extra_files
        .iter()
        .map(|f| render_template(f, &context))
        .collect::<Result<Vec<String>>>()?;
    rendered.file_names = rendered
        .file_names
        .iter()
        .map(|f| render_template(f, &context))
        .collect::<Result<Vec<String>>>()?;
    if let Some(bin) = rendered.bin.as_deref() {
        rendered.bin = Some(render_template(bin, &context)?);
    }
    // Render template strings in extra fields recursively.
    rendered.extra = rendered
        .extra
        .iter()
        .map(|(k, v)| Ok((k.clone(), render_value_deep(v, &context)?)))
        .collect::<Result<BTreeMap<String, Value>>>()?;
    Ok(rendered)
}
fn merge_download_asset_files(mut asset: AssetSpec, download_asset: &AssetSpec) -> AssetSpec {
    if asset.target.is_none() {
        asset.target = download_asset.target.clone();
    }
    asset.file = download_asset.file.clone();
    asset.extra_files = download_asset.extra_files.clone();
    asset.file_names = download_asset.file_names.clone();
    for (key, value) in &download_asset.extra {
        asset
            .extra
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    asset
}

struct SelectedDownload {
    entry: DownloadEntry,
    asset: Option<AssetSpec>,
}

fn select_download_entry(
    raw: &serde_yaml::Value,
    platform: &Platform,
    package: &str,
    version: &str,
    source_id: &str,
    asset: Option<&AssetSpec>,
) -> Result<Option<SelectedDownload>> {
    if raw.is_null() {
        return Ok(None);
    }
    let json_value = serde_json::to_value(raw)?;
    let items = match &json_value {
        Value::Object(map) => match map.get("files") {
            Some(Value::Array(arr)) => arr.clone(),
            _ => vec![json_value.clone()],
        },
        Value::Array(arr) => arr.clone(),
        _ => return Err(msg("source.download must be an array, an object, or null")),
    };
    if items.is_empty() {
        return Ok(None);
    }
    if items.len() == 1 && items[0].get("target").is_none() {
        return selected_download_from_item(&items[0], None, version, source_id, asset).map(Some);
    }

    let mut targets = BTreeMap::new();
    for item in &items {
        let item_targets: Vec<&str> = match item.get("target") {
            Some(Value::String(target)) => vec![target.as_str()],
            Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
            _ => {
                return Err(msg(
                    "download entry with multiple files must each have a 'target' field",
                ))
            }
        };
        if item_targets.is_empty() {
            return Err(msg(
                "download entry with multiple files must each have a 'target' field",
            ));
        }
        for target in item_targets {
            targets.insert(target.to_owned(), item.clone());
        }
    }
    let Some((matched_target, item)) = platform.select(&targets) else {
        return Err(M4aError::UnsupportedTarget {
            package: package.to_owned(),
            targets: targets.keys().cloned().collect(),
        });
    };
    selected_download_from_item(item, Some(matched_target), version, source_id, asset).map(Some)
}

fn selected_download_from_item(
    item: &Value,
    matched_target: Option<&str>,
    version: &str,
    source_id: &str,
    asset: Option<&AssetSpec>,
) -> Result<SelectedDownload> {
    let Value::Object(map) = item else {
        return Err(msg("download entry must be an object"));
    };
    let mut extra = BTreeMap::new();
    for (key, value) in map {
        if key != "target" && key != "file" && key != "url" && key != "files" {
            extra.insert(key.clone(), value.clone());
        }
    }
    if let Some(files) = map.get("files").and_then(Value::as_object) {
        let mut file_values = Vec::new();
        let mut file_names = Vec::new();
        for (name, value) in files {
            let Some(file) = value.as_str() else {
                continue;
            };
            file_names.push(name.clone());
            file_values.push(Value::String(file.to_owned()));
        }
        let Some(file) = file_values
            .first()
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Err(msg("download entry missing file entries"));
        };
        let preliminary = DownloadEntry {
            target: matched_target.map(str::to_owned),
            file,
            extra,
        };
        let entry = render_download_entry(&preliminary, version, source_id, asset)?;
        let mut asset_map = Map::new();
        if let Some(target) = matched_target {
            asset_map.insert("target".to_owned(), Value::String(target.to_owned()));
        }
        asset_map.insert("file".to_owned(), Value::Array(file_values));
        asset_map.insert("file_names".to_owned(), json!(file_names));
        for (key, value) in &entry.extra {
            asset_map.insert(key.clone(), value.clone());
        }
        let asset = asset_from_json(Value::Object(asset_map), version, source_id, Some(&entry))
            .map(Some)?;
        return Ok(SelectedDownload { entry, asset });
    }

    let preliminary = DownloadEntry {
        target: matched_target.map(str::to_owned),
        file: map
            .get("file")
            .or_else(|| map.get("url"))
            .and_then(Value::as_str)
            .ok_or_else(|| msg("download entry missing 'file' or 'url' field"))?
            .to_owned(),
        extra,
    };
    Ok(SelectedDownload {
        entry: render_download_entry(&preliminary, version, source_id, asset)?,
        asset: None,
    })
}

fn render_download_entry(
    entry: &DownloadEntry,
    version: &str,
    source_id: &str,
    asset: Option<&AssetSpec>,
) -> Result<DownloadEntry> {
    let initial_context = context_for(version, source_id, asset, Some(entry), None);
    let mut rendered = entry.clone();
    rendered.file = render_template(&rendered.file, &initial_context)?;
    rendered.extra = rendered
        .extra
        .iter()
        .map(|(key, value)| Ok((key.clone(), render_value_deep(value, &initial_context)?)))
        .collect::<Result<BTreeMap<String, Value>>>()?;

    let rendered_context = context_for(version, source_id, asset, Some(&rendered), None);
    rendered.file = render_template(&rendered.file, &rendered_context)?;
    rendered.extra = rendered
        .extra
        .iter()
        .map(|(key, value)| Ok((key.clone(), render_value_deep(value, &rendered_context)?)))
        .collect::<Result<BTreeMap<String, Value>>>()?;
    Ok(rendered)
}

fn render_value_deep(value: &Value, context: &Value) -> Result<Value> {
    match value {
        Value::String(s) => {
            if s.contains("{{") {
                render_template(s, context).map(Value::String)
            } else {
                Ok(value.clone())
            }
        }
        Value::Array(arr) => {
            let rendered: Result<Vec<Value>> =
                arr.iter().map(|v| render_value_deep(v, context)).collect();
            rendered.map(Value::Array)
        }
        Value::Object(map) => {
            let rendered: Result<Map<String, Value>> = map
                .iter()
                .map(|(k, v)| Ok((k.clone(), render_value_deep(v, context)?)))
                .collect();
            rendered.map(Value::Object)
        }
        _ => Ok(value.clone()),
    }
}

fn context_for(
    version: &str,
    source_id: &str,
    asset: Option<&AssetSpec>,
    download: Option<&DownloadEntry>,
    build: Option<&Value>,
) -> Value {
    let asset_json = match asset {
        Some(asset) => {
            let mut obj = Map::new();
            // Insert the explicit struct fields first.
            if let Some(ref target) = asset.target {
                obj.insert("target".to_owned(), json!(target));
            }
            if let Some(ref file) = asset.file {
                obj.insert("file".to_owned(), json!(file));
            }
            if !asset.extra_files.is_empty() {
                obj.insert("extra_files".to_owned(), json!(asset.extra_files));
            }
            if !asset.file_names.is_empty() {
                obj.insert("file_names".to_owned(), json!(asset.file_names));
            }
            if let Some(ref bin) = asset.bin {
                obj.insert("bin".to_owned(), json!(bin));
            }
            // Promote extra fields to the top level (not nested under "extra").
            for (k, v) in &asset.extra {
                obj.insert(k.clone(), v.clone());
            }
            Value::Object(obj)
        }
        None => Value::Null,
    };
    let download_json = match download {
        Some(download) => {
            let mut obj = Map::new();
            if let Some(ref target) = download.target {
                obj.insert("target".to_owned(), json!(target));
            }
            obj.insert("file".to_owned(), json!(download.file));
            for (key, value) in &download.extra {
                obj.insert(key.clone(), value.clone());
            }
            Value::Object(obj)
        }
        None => Value::Null,
    };
    let mut source_map = Map::new();
    source_map.insert("id".to_owned(), json!(source_id));
    source_map.insert("asset".to_owned(), asset_json);
    source_map.insert("download".to_owned(), download_json);
    if let Some(build) = build {
        source_map.insert("build".to_owned(), build.clone());
    }
    json!({
        "version": version,
        "source": Value::Object(source_map),
    })
}

fn constraint_matches(constraint: &str, version: &str) -> Result<bool> {
    let Some(rest) = constraint.strip_prefix("semver:") else {
        return Ok(false);
    };
    let rest = rest.trim();
    if let Some(max) = rest.strip_prefix("<=") {
        let requested = parse_semver(version)?;
        let max = parse_semver(max.trim())?;
        return Ok(requested <= max);
    }
    if let Some(exact) = rest.strip_prefix('=') {
        return Ok(parse_semver(version)? == parse_semver(exact.trim())?);
    }
    // Bare semver version (e.g. "1.2.3") → exact match
    if parse_semver(rest).is_ok() {
        return Ok(parse_semver(version)? == parse_semver(rest)?);
    }
    Ok(false)
}

fn parse_semver(raw: &str) -> Result<Version> {
    let trimmed = raw.trim().trim_start_matches('v');
    Version::parse(trimmed).map_err(|err| msg(format!("invalid semver '{raw}': {err}")))
}

/// Returns the upper-bound version as a numeric value for comparison.
/// Supports `semver:<=V`, `semver:=V`, and bare semver (e.g. `semver:1.2.3`).
fn constraint_upper_bound(constraint: &str) -> Option<u64> {
    let rest = constraint.strip_prefix("semver:")?.trim();
    let version_str = rest
        .strip_prefix("<=")
        .or_else(|| rest.strip_prefix('='))
        .unwrap_or(rest); // bare version → use as-is
    let trimmed = version_str.trim().trim_start_matches('v');
    let ver = Version::parse(trimmed).ok()?;
    // Use major.minor.patch as a single comparable number
    Some(ver.major * 1_000_000_000 + ver.minor * 1_000_000 + ver.patch * 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RawPackageSpec {
        serde_yaml::from_str(
            r#"
name: demo
description: Demo package
languages: [TypeScript]
categories: [LSP]
source:
  id: pkg:github/acme/demo@v2.0.0
  asset:
    - target: linux_x64_gnu
      file: demo-{{version}}-gnu.zip:bin/
      bin: exec:demo
    - target: linux_x64
      file: demo-{{ version | strip_prefix "v" }}.zip
      bin: demo
  version_overrides:
    - constraint: semver:<=v1.5.0
      id: pkg:github/acme/demo@v1.5.0
      asset:
        - target: linux_x64_gnu
          file: old-{{version}}.zip
          bin: old-demo
bin:
  demo: "{{source.asset.bin}}"
share:
  demo-share: share
opt:
  demo-opt: opt
neovim:
  lspconfig: demo_ls
"#,
        )
        .unwrap()
    }

    #[test]
    fn normalizes_platform_asset_and_expressions() {
        let pkg = sample()
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(pkg.version, "v2.0.0");
        assert_eq!(
            pkg.source.asset.as_ref().unwrap().file.as_deref(),
            Some("demo-v2.0.0-gnu.zip:bin/")
        );
        assert_eq!(pkg.bins.get("demo").unwrap(), "exec:demo");
        assert_eq!(pkg.neovim_lspconfig.as_deref(), Some("demo_ls"));
    }

    #[test]
    fn applies_version_override() {
        let pkg = sample()
            .normalize(&Platform::new("linux", "x64", Some("gnu")), Some("v1.2.0"))
            .unwrap();
        assert_eq!(pkg.version, "v1.2.0");
        assert!(pkg.source.id.ends_with("@v1.2.0"));
        assert_eq!(
            pkg.source.asset.as_ref().unwrap().file.as_deref(),
            Some("old-v1.2.0.zip")
        );
    }

    #[test]
    fn reports_unsupported_targets() {
        let err = sample()
            .normalize(&Platform::new("win", "x64", None), None)
            .unwrap_err();
        assert!(matches!(err, M4aError::UnsupportedTarget { .. }));
    }

    #[test]
    fn accepts_object_asset_with_matching_target() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:github/acme/demo@v1.0.0
  asset:
    target: linux_x64_gnu
    file: demo.zip
    bin: demo
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(
            pkg.source.asset.as_ref().unwrap().file.as_deref(),
            Some("demo.zip")
        );
    }

    #[test]
    fn rejects_object_asset_with_mismatched_target() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:github/acme/demo@v1.0.0
  asset:
    target: win_x64
    file: demo.zip
"#,
        )
        .unwrap();
        let err = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap_err();
        assert!(matches!(
            err,
            M4aError::UnsupportedTarget { package, targets }
                if package == "demo" && targets == vec!["win_x64".to_owned()]
        ));
    }

    #[test]
    fn accepts_object_asset_without_target() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:github/acme/demo@v1.0.0
  asset:
    file: demo.zip
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(
            pkg.source.asset.as_ref().unwrap().file.as_deref(),
            Some("demo.zip")
        );
    }

    #[test]
    fn renders_download_entries_with_selected_asset_context() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:generic/acme/demo@1.0.0
  asset:
    target: linux_x64_gnu
    file: demo-linux.tar.gz
  download:
    target: linux_x64_gnu
    file: "https://example.test/{{source.asset.target}}/{{source.asset.file}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();

        assert_eq!(
            pkg.source
                .download
                .as_ref()
                .map(|download| download.file.as_str()),
            Some("https://example.test/linux_x64_gnu/demo-linux.tar.gz")
        );
    }
    #[test]
    fn renders_download_entries_with_matched_array_asset_target() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:generic/acme/demo@1.0.0
  asset:
    target: [linux_x64_gnu, linux_x64]
    file: demo-linux.tar.gz
  download:
    target: linux_x64_gnu
    file: "https://example.test/{{source.asset.target}}/{{source.asset.file}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();

        let asset = pkg.source.asset.as_ref().unwrap();
        assert_eq!(asset.target.as_deref(), Some("linux_x64_gnu"));
        assert_eq!(
            pkg.source
                .download
                .as_ref()
                .map(|download| download.file.as_str()),
            Some("https://example.test/linux_x64_gnu/demo-linux.tar.gz")
        );
    }

    #[test]
    fn propagates_unsupported_download_targets() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:generic/acme/demo@1.0.0
  download:
    - target: darwin_arm64
      file: demo-macos.tar.gz
"#,
        )
        .unwrap();
        let err = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap_err();
        assert!(matches!(
            err,
            M4aError::UnsupportedTarget { package, targets }
                if package == "demo" && targets == vec!["darwin_arm64".to_owned()]
        ));
    }

    #[test]
    fn propagates_malformed_download_specs() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: demo
source:
  id: pkg:generic/acme/demo@1.0.0
  download:
    - target: linux_x64_gnu
"#,
        )
        .unwrap();
        let err = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "download entry missing 'file' or 'url' field"
        );
    }

    #[test]
    fn normalizes_download_file_maps_as_generic_asset_files() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: jdtls
source:
  id: pkg:generic/eclipse/eclipse.jdt.ls@v1.58.0
  download:
    - target: linux
      files:
        jdtls.tar.gz: https://example.test/jdtls/{{ version | strip_prefix "v" }}/jdtls.tar.gz
        lombok.jar: https://example.test/lombok.jar
      config: config_{{ version | strip_prefix "v" }}/
share:
  jdtls/config/: "{{source.download.config}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        let asset = pkg.source.asset.as_ref().unwrap();

        assert_eq!(
            asset.file.as_deref(),
            Some("https://example.test/jdtls/1.58.0/jdtls.tar.gz")
        );
        assert_eq!(asset.extra_files, ["https://example.test/lombok.jar"]);
        assert_eq!(asset.file_names, ["jdtls.tar.gz", "lombok.jar"]);
        assert_eq!(
            pkg.source
                .download
                .as_ref()
                .and_then(|download| download.extra.get("config"))
                .and_then(Value::as_str),
            Some("config_1.58.0/")
        );
        assert_eq!(
            pkg.share.get("jdtls/config/").map(String::as_str),
            Some("config_1.58.0/")
        );
    }
    #[test]
    fn merges_download_file_map_into_metadata_only_asset() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: jdtls
source:
  id: pkg:generic/eclipse/eclipse.jdt.ls@v1.58.0
  asset:
    bin: jdtls/bin/jdtls
    marker: kept
  download:
    - target: linux
      files:
        jdtls.tar.gz: https://example.test/jdtls/{{ version | strip_prefix "v" }}/jdtls.tar.gz
        lombok.jar: https://example.test/lombok.jar
      config: config_{{ version | strip_prefix "v" }}/
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        let asset = pkg.source.asset.as_ref().unwrap();

        assert_eq!(asset.target.as_deref(), Some("linux"));
        assert_eq!(asset.bin.as_deref(), Some("jdtls/bin/jdtls"));
        assert_eq!(
            asset.extra.get("marker").and_then(Value::as_str),
            Some("kept")
        );
        assert_eq!(
            asset.extra.get("config").and_then(Value::as_str),
            Some("config_1.58.0/")
        );
        assert_eq!(
            asset.file.as_deref(),
            Some("https://example.test/jdtls/1.58.0/jdtls.tar.gz")
        );
        assert_eq!(asset.extra_files, ["https://example.test/lombok.jar"]);
        assert_eq!(asset.file_names, ["jdtls.tar.gz", "lombok.jar"]);
    }

    #[test]
    fn normalizes_single_object_download_file_maps() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: jdtls
source:
  id: pkg:generic/eclipse/eclipse.jdt.ls@v1.58.0
  download:
    target: linux
    files:
      jdtls.tar.gz: "{{source.download.base}}/jdtls.tar.gz"
      lombok.jar: "{{source.download.base}}/lombok.jar"
    base: https://example.test/jdtls/{{ version | strip_prefix "v" }}
    config: config_linux/
share:
  jdtls/config/: "{{source.download.config}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();

        let asset = pkg.source.asset.as_ref().unwrap();
        assert_eq!(
            asset.file.as_deref(),
            Some("https://example.test/jdtls/1.58.0/jdtls.tar.gz")
        );
        assert_eq!(asset.file_names, ["jdtls.tar.gz", "lombok.jar"]);
        assert_eq!(
            pkg.share.get("jdtls/config/").map(String::as_str),
            Some("config_linux/")
        );
    }

    #[test]
    fn normalizes_wrapped_download_file_arrays() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: wrapped
source:
  id: pkg:generic/acme/wrapped@1.2.3
  download:
    files:
      - target: linux_x64_gnu
        file: https://example.test/wrapped/{{ version }}.tar.gz
        config: config_{{ version }}/
share:
  wrapped/config/: "{{source.download.config}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();

        assert_eq!(
            pkg.source
                .download
                .as_ref()
                .map(|download| download.file.as_str()),
            Some("https://example.test/wrapped/1.2.3.tar.gz")
        );
        assert_eq!(
            pkg.share.get("wrapped/config/").map(String::as_str),
            Some("config_1.2.3/")
        );
    }

    #[test]
    fn extracts_build_scripts() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: scripted
source:
  id: pkg:generic/acme/scripted@1.0.0
  build:
    run:
      - echo build
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(pkg.source.build_scripts, vec!["echo build"]);
    }

    #[test]
    fn selects_platform_build_for_bin_templates() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: java-language-server
source:
  id: pkg:github/georgewfraser/java-language-server@v0.2.39
  build:
    - target: linux
      run:
        - ./scripts/link_linux.sh
        - mvn package -DskipTests
      bin:
        lsp: exec:dist/lang_server_linux.sh
        dap: exec:dist/debug_adapter_linux.sh
    - target: win
      run:
        - bash .\scripts\link_windows.sh
        - mvn package -DskipTests
      bin:
        lsp: dist/lang_server_windows.cmd
        dap: dist/debug_adapter_windows.cmd
bin:
  java-language-server: "{{source.build.bin.lsp}}"
  java-language-server-debugger: "{{source.build.bin.dap}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(
            pkg.bins.get("java-language-server").unwrap(),
            "exec:dist/lang_server_linux.sh"
        );
        assert_eq!(
            pkg.bins.get("java-language-server-debugger").unwrap(),
            "exec:dist/debug_adapter_linux.sh"
        );
        assert_eq!(
            pkg.source.build_scripts,
            vec!["./scripts/link_linux.sh", "mvn package -DskipTests"]
        );
    }

    #[test]
    fn build_target_specificity_beats_yaml_order() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: scripted
source:
  id: pkg:generic/acme/scripted@1.0.0
  build:
    - target: linux
      run:
        - generic-linux
      bin:
        scripted: generic
    - target: linux_x64_gnu
      run:
        - specific-linux
      bin:
        scripted: specific
bin:
  scripted: "{{source.build.bin.scripted}}"
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(pkg.bins.get("scripted").unwrap(), "specific");
        assert_eq!(pkg.source.build_scripts, vec!["specific-linux"]);
    }

    #[test]
    fn nested_build_run_target_specificity_beats_yaml_order() {
        let raw: RawPackageSpec = serde_yaml::from_str(
            r#"
name: scripted
source:
  id: pkg:generic/acme/scripted@1.0.0
  build:
    run:
      - target: linux
        run:
          - generic-linux
      - target: linux_x64_gnu
        run:
          - specific-linux
"#,
        )
        .unwrap();
        let pkg = raw
            .normalize(&Platform::new("linux", "x64", Some("gnu")), None)
            .unwrap();
        assert_eq!(pkg.source.build_scripts, vec!["specific-linux"]);
    }
}
