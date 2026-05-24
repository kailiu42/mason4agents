use crate::types::{M4aError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Purl {
    pub ty: String,
    pub namespace: Option<String>,
    pub name: String,
    pub version: Option<String>,
    pub qualifiers: BTreeMap<String, String>,
    pub subpath: Option<String>,
}

impl Purl {
    pub fn parse(input: &str) -> Result<Self> {
        let Some(rest) = input.strip_prefix("pkg:") else {
            return Err(M4aError::InvalidPurl(input.to_owned()));
        };
        // Allow pkg:// scheme (equivalent to pkg:)
        let rest = if let Some(after_double) = rest.strip_prefix("//") {
            after_double.trim_start_matches('/')
        } else {
            rest
        };
        let (without_subpath, subpath) = split_once(rest, '#');
        let (without_qualifiers, qualifiers_raw) = split_once(without_subpath, '?');
        let (ty, path) = split_once(without_qualifiers, '/');
        let Some(path) = path else {
            return Err(M4aError::InvalidPurl(input.to_owned()));
        };
        if ty.is_empty() || path.is_empty() {
            return Err(M4aError::InvalidPurl(input.to_owned()));
        }
        let mut qualifiers = BTreeMap::new();
        if let Some(raw) = qualifiers_raw {
            for pair in raw.split('&').filter(|part| !part.is_empty()) {
                let (key, value) = split_once(pair, '=');
                let value = value.unwrap_or("");
                qualifiers.insert(decode(key)?, decode(value)?);
            }
        }

        let (path_no_version, version) = split_version(path);
        let segments: Vec<&str> = path_no_version
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if segments.is_empty() {
            return Err(M4aError::InvalidPurl(input.to_owned()));
        }
        let name = decode(segments[segments.len() - 1])?;
        let namespace = if segments.len() > 1 {
            Some(decode(&segments[..segments.len() - 1].join("/"))?)
        } else {
            None
        };
        Ok(Self {
            ty: ty.to_ascii_lowercase(),
            namespace,
            name,
            version: match version {
                Some(v) => Some(decode(v)?),
                None => None,
            },
            qualifiers,
            subpath: match subpath {
                Some(s) => Some(decode(s)?),
                None => None,
            },
        })
    }

    pub fn package_path(&self) -> String {
        match &self.namespace {
            Some(ns) => format!("{ns}/{}", self.name),
            None => self.name.clone(),
        }
    }

    pub fn with_version(&self, version: Option<String>) -> Self {
        let mut p = self.clone();
        p.version = version;
        p
    }
}

fn split_once(input: &str, sep: char) -> (&str, Option<&str>) {
    match input.split_once(sep) {
        Some((left, right)) => (left, Some(right)),
        None => (input, None),
    }
}

fn split_version(path: &str) -> (&str, Option<&str>) {
    match path.rfind('@') {
        Some(0) | None => (path, None),
        Some(index) => (&path[..index], Some(&path[index + 1..])),
    }
}

fn decode(input: &str) -> Result<String> {
    urlencoding::decode(input)
        .map(|cow| cow.into_owned())
        .map_err(|_| M4aError::InvalidPurl(input.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npm() {
        let p = Purl::parse("pkg:npm/typescript-language-server@5.2.0").unwrap();
        assert_eq!(p.ty, "npm");
        assert_eq!(p.namespace, None);
        assert_eq!(p.name, "typescript-language-server");
        assert_eq!(p.version.as_deref(), Some("5.2.0"));
    }

    #[test]
    fn parses_scoped_npm() {
        let p = Purl::parse("pkg:npm/%40scope/name@1.0.0").unwrap();
        assert_eq!(p.namespace.as_deref(), Some("@scope"));
        assert_eq!(p.name, "name");
        assert_eq!(p.version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn parses_github() {
        let p = Purl::parse("pkg:github/LuaLS/lua-language-server@3.18.2").unwrap();
        assert_eq!(p.ty, "github");
        assert_eq!(p.namespace.as_deref(), Some("LuaLS"));
        assert_eq!(p.name, "lua-language-server");
    }

    #[test]
    fn parses_generic_pypi_cargo_go_openvsx_with_qualifiers_subpath() {
        for input in [
            "pkg:generic/acme/tool@1.2.3?download_url=https%3A%2F%2Fe.test%2Fa.zip#bin",
            "pkg:pypi/ruff@0.1.0",
            "pkg:cargo/ripgrep@14.1.0",
            "pkg:golang/golang.org/x/tools/gopls@0.16.0",
            "pkg:openvsx/redhat/java@1.0.0",
        ] {
            let parsed = Purl::parse(input).unwrap();
            assert!(!parsed.ty.is_empty());
            assert!(!parsed.name.is_empty());
        }
        let generic = Purl::parse(
            "pkg:generic/acme/tool@1.2.3?download_url=https%3A%2F%2Fe.test%2Fa.zip#bin",
        )
        .unwrap();
        assert_eq!(
            generic.qualifiers.get("download_url").unwrap(),
            "https://e.test/a.zip"
        );
        assert_eq!(generic.subpath.as_deref(), Some("bin"));
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(Purl::parse("npm/foo").is_err());
        assert!(Purl::parse("pkg:npm").is_err());
        assert!(Purl::parse("pkg:/foo").is_err());
    }
}
