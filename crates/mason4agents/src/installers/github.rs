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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_spec::NormalizedSource;
    use std::collections::BTreeMap;

    #[test]
    fn constructs_github_release_asset_url() {
        let src = NormalizedSource {
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
        };
        assert_eq!(
            release_asset_url(&src, "tool.zip").unwrap(),
            "https://github.com/acme/tool/releases/download/v1.0.0/tool.zip"
        );
    }
}
