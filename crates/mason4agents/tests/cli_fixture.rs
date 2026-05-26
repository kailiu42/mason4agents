use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::{json, Value};
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
fn stderr_progress_events(assert: &assert_cmd::assert::Assert) -> Vec<Value> {
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr);
    assert!(!stderr.trim().is_empty());
    stderr
        .lines()
        .map(|line| {
            let event: Value = serde_json::from_str(line).unwrap();
            assert_eq!(event["kind"], "progress");
            assert_eq!(event["schema_version"], 1);
            assert!(event["elapsed_ms"].as_u64().is_some());
            assert!(event["message"].as_str().is_some());
            event
        })
        .collect()
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

fn write_registry_package(
    root: &Path,
    name: &str,
    languages: &[&str],
    categories: &[&str],
    version: &str,
) {
    let dir = root.join("registry/packages").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("package.yaml"),
        format!(
            r#"
name: {name}
description: {name} fixture
languages: [{}]
categories: [{}]
source:
  id: pkg:generic/acme/{name}@{version}
"#,
            languages.join(","),
            categories.join(",")
        ),
    )
    .unwrap();
}

fn write_suggestions_registry(root: &Path, packages: &[&str]) -> PathBuf {
    for package in packages {
        let (languages, categories) = match *package {
            "rust-analyzer" => (&["Rust"][..], &["LSP"][..]),
            "gopls" => (&["Go"][..], &["LSP"][..]),
            "goimports" | "gofumpt" => (&["Go"][..], &["Formatter"][..]),
            "golangci-lint" => (&["Go"][..], &["Linter"][..]),
            "pyright" => (&["Python"][..], &["LSP"][..]),
            "ruff" => (&["Python"][..], &["Linter", "Formatter"][..]),
            "typescript-language-server" => (&["TypeScript", "JavaScript"][..], &["LSP"][..]),
            "biome" => (
                &["TypeScript", "JavaScript"][..],
                &["Linter", "Formatter"][..],
            ),
            _ => (&["Fixture"][..], &["Tool"][..]),
        };
        write_registry_package(root, package, languages, categories, "1.0.0");
    }
    root.join("registry")
}

fn refresh_fixture_registry(root: &Path, registry: &Path) {
    cmd(root)
        .args([
            "refresh",
            "--registry",
            registry.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success();
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
fn cli_json_progress_uses_stderr_ndjson_and_keeps_stdout_envelope() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = write_registry(tmp.path());

    let refresh_assert = cmd(tmp.path())
        .args([
            "refresh",
            "--registry",
            registry.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success();
    let refresh_stdout: Value =
        serde_json::from_slice(&refresh_assert.get_output().stdout).unwrap();
    assert_eq!(refresh_stdout["ok"], true);
    let refresh_events = stderr_progress_events(&refresh_assert);
    assert!(refresh_events.iter().any(|event| {
        event["operation"] == "refresh"
            && event["phase"] == "registry"
            && event["status"] == "succeeded"
    }));

    let install_assert = cmd(tmp.path())
        .args(["install", "hello", "--json"])
        .assert()
        .success();
    let install_stdout: Value =
        serde_json::from_slice(&install_assert.get_output().stdout).unwrap();
    assert_eq!(install_stdout["ok"], true);
    assert_eq!(install_stdout["data"][0]["package"], "hello");
    let install_events = stderr_progress_events(&install_assert);
    assert!(install_events.iter().any(|event| {
        event["operation"] == "install"
            && event["package"] == "hello"
            && event["phase"] == "package"
            && event["status"] == "succeeded"
    }));
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

#[test]
fn cli_suggested_uses_lazyvim_curated_mapping_and_install_state() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = write_suggestions_registry(
        tmp.path(),
        &[
            "rust-analyzer",
            "gopls",
            "goimports",
            "gofumpt",
            "golangci-lint",
            "pyright",
            "ruff",
            "typescript-language-server",
        ],
    );
    refresh_fixture_registry(tmp.path(), &registry);

    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
    fs::write(project.join("go.mod"), "module example.com/demo\n").unwrap();
    fs::write(
        project.join("pyproject.toml"),
        "[project]\nname = \"demo\"\n",
    )
    .unwrap();
    fs::write(project.join("tsconfig.json"), "{}").unwrap();

    let state_file = tmp.path().join("state/mason4agents/installed.json");
    fs::create_dir_all(state_file.parent().unwrap()).unwrap();
    fs::write(
        &state_file,
        serde_json::to_vec(&json!({
            "packages": {
                "rust-analyzer": {
                    "name": "rust-analyzer",
                    "version": "0.9.0",
                    "source_id": "pkg:generic/acme/rust-analyzer@0.9.0",
                    "bins": {},
                    "share": {},
                    "opt": {},
                    "installed_at": "2026-01-01T00:00:00Z"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let suggested = output_json(
        cmd(tmp.path())
            .args(["suggested", "--path", project.to_str().unwrap(), "--json"])
            .assert()
            .success(),
    );
    let names: Vec<&str> = suggested["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();

    assert_eq!(
        names,
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
    assert_eq!(suggested["data"][0]["installed"], true);
    assert_eq!(suggested["data"][0]["outdated"], true);
    assert!(suggested["data"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("Cargo.toml"));
}

#[test]
fn cli_suggested_filters_missing_registry_packages_and_uses_cached_curated_source() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = write_suggestions_registry(tmp.path(), &["rust-analyzer"]);
    refresh_fixture_registry(tmp.path(), &registry);

    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();

    let source_path = tmp.path().join("curated-source.json");
    fs::write(
        &source_path,
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "source": "fixture-lazyvim",
            "source_ref": "fixture",
            "fetched_at": "2026-01-01T00:00:00Z",
            "rules": [{
                "signal": "rust",
                "reason": "fixture curated rule",
                "packages": [
                    { "package": "missing-rust", "capability": "LSP" },
                    { "package": "rust-analyzer", "capability": "LSP" }
                ]
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let suggested = output_json(
        cmd(tmp.path())
            .args([
                "suggested",
                "--path",
                project.to_str().unwrap(),
                "--refresh-suggestions",
                "--suggestions-source",
                source_path.to_str().unwrap(),
                "--json",
            ])
            .assert()
            .success(),
    );
    let names: Vec<&str> = suggested["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();

    assert_eq!(names, ["rust-analyzer"]);
    assert_eq!(suggested["data"][0]["source"], "fixture-lazyvim");
    let cache_file = tmp
        .path()
        .join("cache/mason4agents/suggestions/lazyvim-curated.json");
    assert!(cache_file.exists());

    let stale = output_json(
        cmd(tmp.path())
            .args([
                "suggested",
                "--path",
                project.to_str().unwrap(),
                "--refresh-suggestions",
                "--suggestions-source",
                "file:///no/such/lazyvim-curated.json",
                "--json",
            ])
            .assert()
            .success(),
    );
    assert_eq!(stale["data"][0]["source"], "fixture-lazyvim");
}
