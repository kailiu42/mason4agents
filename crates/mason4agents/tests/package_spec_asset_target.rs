use mason4agents::package_spec::RawPackageSpec;
use mason4agents::platform::Platform;
use mason4agents::M4aError;

fn normalize_asset(
    package_yaml: &str,
) -> Result<mason4agents::package_spec::NormalizedPackage, M4aError> {
    let raw: RawPackageSpec = serde_yaml::from_str(package_yaml).unwrap();
    raw.normalize(&Platform::new("linux", "x64", Some("gnu")), None)
}

#[test]
fn object_asset_target_must_match_platform() {
    let pkg = normalize_asset(
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

    assert_eq!(
        pkg.source.asset.as_ref().unwrap().file.as_deref(),
        Some("demo.zip")
    );
}

#[test]
fn object_asset_target_mismatch_returns_unsupported_target() {
    let err = normalize_asset(
        r#"
name: demo
source:
  id: pkg:github/acme/demo@v1.0.0
  asset:
    target: win_x64
    file: demo.zip
"#,
    )
    .unwrap_err();

    assert!(matches!(
        err,
        M4aError::UnsupportedTarget { package, targets }
            if package == "demo" && targets == vec!["win_x64".to_owned()]
    ));
}

#[test]
fn object_asset_without_target_still_normalizes() {
    let pkg = normalize_asset(
        r#"
name: demo
source:
  id: pkg:github/acme/demo@v1.0.0
  asset:
    file: demo.zip
"#,
    )
    .unwrap();

    assert_eq!(
        pkg.source.asset.as_ref().unwrap().file.as_deref(),
        Some("demo.zip")
    );
}
