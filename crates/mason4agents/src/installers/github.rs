use crate::package_spec::NormalizedSource;
use crate::types::{msg, Result};

pub fn release_asset_url(source: &NormalizedSource, file: &str) -> Result<String> {
    let namespace = source
        .namespace
        .as_ref()
        .ok_or_else(|| msg("github package source requires owner namespace"))?;
    Ok(format!(
        "https://github.com/{}/{}/releases/download/{}/{}",
        namespace, source.package, source.version, file
    ))
}

pub fn source_archive_url(source: &NormalizedSource) -> Result<String> {
    let namespace = source
        .namespace
        .as_ref()
        .ok_or_else(|| msg("github package source requires owner namespace"))?;
    Ok(format!(
        "https://github.com/{}/{}/archive/refs/tags/{}.tar.gz",
        namespace, source.package, source.version
    ))
}

pub(crate) fn source_archive_strip_prefix(source: &NormalizedSource) -> String {
    let version_dir = source
        .version
        .strip_prefix('v')
        .filter(|rest| {
            rest.as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_digit())
        })
        .unwrap_or(&source.version);
    let mut prefix = String::with_capacity(source.package.len() + 1 + version_dir.len());
    prefix.push_str(&source.package);
    prefix.push('-');
    for ch in version_dir.chars() {
        prefix.push(if ch == '/' { '-' } else { ch });
    }
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_spec::NormalizedSource;
    use std::collections::BTreeMap;

    fn source() -> NormalizedSource {
        NormalizedSource {
            id: "pkg:github/acme/tool@v1.0.0".to_owned(),
            source_type: "github".to_owned(),
            namespace: Some("acme".to_owned()),
            package: "tool".to_owned(),
            version: "v1.0.0".to_owned(),
            asset: None,
            extra_packages: vec![],
            build_scripts: vec![],
            qualifiers: BTreeMap::new(),
            subpath: None,
            build: None,
            download: None,
        }
    }

    #[test]
    fn constructs_github_release_asset_url() {
        let src = source();
        assert_eq!(
            release_asset_url(&src, "tool.zip").unwrap(),
            "https://github.com/acme/tool/releases/download/v1.0.0/tool.zip"
        );
    }

    #[test]
    fn constructs_github_source_archive_url() {
        let src = source();
        assert_eq!(
            source_archive_url(&src).unwrap(),
            "https://github.com/acme/tool/archive/refs/tags/v1.0.0.tar.gz"
        );
    }

    #[test]
    fn strips_github_archive_top_level_directory() {
        let src = source();
        assert_eq!(source_archive_strip_prefix(&src), "tool-1.0.0");
    }

    #[test]
    fn strips_github_archive_prefix_for_slash_tag() {
        let mut src = source();
        src.version = "v1/2/3".to_owned();
        assert_eq!(source_archive_strip_prefix(&src), "tool-1-2-3");
    }
}
