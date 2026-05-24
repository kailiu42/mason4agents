use assert_cmd::Command;
use serde_json::Value;

fn output_json(assert: assert_cmd::assert::Assert) -> Value {
    serde_json::from_slice(&assert.get_output().stdout).unwrap()
}

#[test]
#[ignore = "network smoke test; run explicitly during release verification"]
fn real_mason_registry_refreshes_and_searches_known_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let base_env = [
        ("HOME", tmp.path().to_path_buf()),
        ("MASON4AGENTS_DATA_HOME", tmp.path().join("data")),
        ("MASON4AGENTS_CACHE_HOME", tmp.path().join("cache")),
        ("MASON4AGENTS_STATE_HOME", tmp.path().join("state")),
    ];
    let mut refresh = Command::cargo_bin("mason4agents").unwrap();
    for (k, v) in &base_env {
        refresh.env(k, v);
    }
    let refreshed = output_json(refresh.args(["refresh", "--json"]).assert().success());
    assert!(refreshed["data"]["package_count"].as_u64().unwrap() > 100);

    for package in [
        "typescript-language-server",
        "lua-language-server",
        "rust-analyzer",
        "stylua",
    ] {
        let mut search = Command::cargo_bin("mason4agents").unwrap();
        for (k, v) in &base_env {
            search.env(k, v);
        }
        let result = output_json(
            search
                .args(["search", package, "--json"])
                .assert()
                .success(),
        );
        let names = result["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(
            names.contains(&package),
            "{package} missing from real registry search"
        );
    }
}
