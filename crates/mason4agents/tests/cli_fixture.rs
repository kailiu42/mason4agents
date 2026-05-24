use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

fn cmd(root: &Path) -> Command {
    let mut command = Command::cargo_bin("mason4agents").unwrap();
    command
        .env("HOME", root)
        .env("MASON4AGENTS_DATA_HOME", root.join("data"))
        .env("MASON4AGENTS_CACHE_HOME", root.join("cache"))
        .env("MASON4AGENTS_STATE_HOME", root.join("state"));
    command
}

fn output_json(assert: assert_cmd::assert::Assert) -> Value {
    let output = assert.get_output();
    serde_json::from_slice(&output.stdout).unwrap()
}

fn write_zip(path: &Path, text: &[u8]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("pkg/bin/hello", FileOptions::<()>::default())
        .unwrap();
    zip.write_all(text).unwrap();
    zip.finish().unwrap();
}

fn write_registry(root: &Path) -> PathBuf {
    let archives = root.join("archives");
    fs::create_dir_all(&archives).unwrap();
    write_zip(&archives.join("1.0.0-gnu.zip"), b"#!/bin/sh\necho gnu\n");
    write_zip(
        &archives.join("fallback.zip"),
        b"#!/bin/sh\necho fallback\n",
    );
    let dir = root.join("registry/packages/hello");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("package.yaml"),
        format!(
            r#"
name: hello
description: Hello fixture
languages: [Shell]
categories: [Formatter]
source:
  id: pkg:generic/acme/hello@v1.0.0
  asset:
    - target: linux_x64_gnu
      file: '{}/{{{{ version | strip_prefix "v" }}}}-gnu.zip:pkg/bin/'
      bin: hello
    - target: linux_x64
      file: '{}/fallback.zip:pkg/bin/'
      bin: hello
bin:
  hello: '{{{{source.asset.bin}}}}'
share:
  hello-share: share
"#,
            archives.display(),
            archives.display()
        ),
    )
    .unwrap();
    root.join("registry")
}

#[test]
fn cli_refresh_search_install_which_env_uninstall_flow() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = write_registry(tmp.path());

    let refreshed = output_json(
        cmd(tmp.path())
            .args([
                "refresh",
                "--registry",
                registry.to_str().unwrap(),
                "--json",
            ])
            .assert()
            .success(),
    );
    assert_eq!(refreshed["ok"], true);
    assert_eq!(refreshed["data"]["package_count"], 1);

    let search = output_json(
        cmd(tmp.path())
            .args([
                "search",
                "hello",
                "--category",
                "Formatter",
                "--language",
                "Shell",
                "--json",
            ])
            .assert()
            .success(),
    );
    assert_eq!(search["data"].as_array().unwrap().len(), 1);
    assert_eq!(search["data"][0]["version"], "v1.0.0");

    let installed = output_json(
        cmd(tmp.path())
            .args(["install", "hello", "--json"])
            .assert()
            .success(),
    );
    assert_eq!(installed["data"][0]["package"], "hello");
    let bin = tmp.path().join("data/mason4agents/bin/hello");
    assert!(bin.exists());

    let which = output_json(
        cmd(tmp.path())
            .args(["which", "hello", "--json"])
            .assert()
            .success(),
    );
    assert_eq!(which["data"]["package"], "hello");
    assert!(which["data"]["path"]
        .as_str()
        .unwrap()
        .ends_with("/bin/hello"));

    let list_installed = output_json(
        cmd(tmp.path())
            .args(["list", "--installed", "--json"])
            .assert()
            .success(),
    );
    assert_eq!(list_installed["data"].as_array().unwrap().len(), 1);

    let env = output_json(
        cmd(tmp.path())
            .args(["env", "--shell", "bash", "--json"])
            .assert()
            .success(),
    );
    assert!(env["data"]["shell"]
        .as_str()
        .unwrap()
        .contains("mason4agents/bin"));

    let doctor = output_json(
        cmd(tmp.path())
            .args(["doctor", "--json"])
            .assert()
            .success(),
    );
    assert_eq!(doctor["data"]["registry"]["cache_present"], true);

    let uninstalled = output_json(
        cmd(tmp.path())
            .args(["uninstall", "hello", "--json"])
            .assert()
            .success(),
    );
    assert_eq!(uninstalled["data"][0]["removed"], true);
    assert!(!bin.exists());
}

#[test]
fn cli_error_stdout_is_stable_json() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = write_registry(tmp.path());
    cmd(tmp.path())
        .args([
            "refresh",
            "--registry",
            registry.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success();
    let value = output_json(
        cmd(tmp.path())
            .args(["install", "missing", "--json"])
            .assert()
            .failure()
            .stdout(predicate::str::contains("package_not_found")),
    );
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "package_not_found");
}
