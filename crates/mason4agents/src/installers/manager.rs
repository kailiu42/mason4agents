use crate::package_spec::NormalizedSource;
use crate::types::{M4aError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

pub fn manager_for_source_type(source_type: &str) -> Option<&'static str> {
    match source_type {
        "npm" => Some("npm"),
        "pypi" => Some("python3"),
        "cargo" => Some("cargo"),
        "golang" => Some("go"),
        "gem" => Some("gem"),
        "composer" => Some("composer"),
        "luarocks" => Some("luarocks"),
        "nuget" => Some("nuget"),
        _ => None,
    }
}

pub fn package_manager_types() -> &'static [&'static str] {
    &[
        "npm", "pypi", "cargo", "golang", "gem", "composer", "luarocks", "nuget",
    ]
}

pub fn ensure_manager(source_type: &str) -> Result<()> {
    if let Some(manager) = manager_for_source_type(source_type) {
        if command_exists(manager) {
            if source_type == "pypi" && resolve_python_with_pip().is_none() {
                return Err(M4aError::MissingManager {
                    manager: manager.to_owned(),
                    source_type: source_type.to_owned(),
                });
            }
            return Ok(());
        }
        if source_type == "pypi" {
            if resolve_python_with_pip().is_none() {
                return Err(M4aError::MissingManager {
                    manager: manager.to_owned(),
                    source_type: source_type.to_owned(),
                });
            }
            return Ok(());
        }
        return Err(M4aError::MissingManager {
            manager: manager.to_owned(),
            source_type: source_type.to_owned(),
        });
    }
    Ok(())
}

fn resolve_python_with_pip() -> Option<String> {
    for candidate in &["python3", "python"] {
        if command_exists(candidate) {
            if let Ok(out) = Command::new(candidate)
                .args(["-m", "pip", "--version"])
                .output()
            {
                if out.status.success() {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}
pub fn command_exists(program: &str) -> bool {
    if Path::new(program).is_absolute() {
        return is_executable(Path::new(program));
    }
    let Some(path_var) = env::var_os("PATH") else {
        return false;
    };
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(program);
        if is_executable(&candidate) {
            return true;
        }
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            if is_executable(&candidate.with_extension(ext)) {
                return true;
            }
        }
    }
    false
}

fn is_executable(path: &Path) -> bool {
    match path.metadata() {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

pub fn build_install_command(source: &NormalizedSource, staging: &Path) -> Result<CommandSpec> {
    let spec = match source.source_type.as_str() {
        "npm" => npm_command(source, staging),
        "pypi" => pypi_command(source, staging)?,
        "cargo" => cargo_command(source, staging),
        "golang" => golang_command(source, staging),
        "gem" => gem_command(source, staging),
        "composer" => composer_command(source, staging),
        "luarocks" => luarocks_command(source, staging),
        "nuget" => nuget_command(source, staging),
        other => {
            return Err(M4aError::MissingManager {
                manager: other.to_owned(),
                source_type: other.to_owned(),
            })
        }
    };
    Ok(spec)
}

pub fn run_install_command(spec: &CommandSpec) -> Result<()> {
    let output = Command::new(&spec.program)
        .args(&spec.args)
        .envs(&spec.env)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(M4aError::CommandFailed {
            program: spec.program.clone(),
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn package_with_version(source: &NormalizedSource, sep: &str) -> String {
    let name = match &source.namespace {
        Some(namespace) if source.source_type == "npm" && namespace.starts_with('@') => {
            format!("{namespace}/{}", source.package)
        }
        Some(namespace) if source.source_type == "golang" => {
            let mut base = format!("{namespace}/{}", source.package);
            if let Some(subpath) = &source.subpath {
                base.push('/');
                base.push_str(subpath);
            }
            base
        }
        Some(namespace) => format!("{namespace}/{}", source.package),
        None => source.package.clone(),
    };
    format!("{name}{sep}{}", source.version)
}

fn npm_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    let mut args = vec![
        "install".to_owned(),
        "--prefix".to_owned(),
        staging.display().to_string(),
        package_with_version(source, "@"),
    ];
    args.extend(source.extra_packages.iter().cloned());
    CommandSpec {
        program: "npm".to_owned(),
        args,
        env: BTreeMap::new(),
    }
}

fn pypi_command(source: &NormalizedSource, staging: &Path) -> Result<CommandSpec> {
    if let Some(file_name) = source.qualifiers.get("file_name") {
        return Err(M4aError::Message(format!(
            "file_name qualifier '{file_name}' is not supported for PyPI packages"
        )));
    }
    let mut args = vec![
        "-m".to_owned(),
        "pip".to_owned(),
        "install".to_owned(),
        "--target".to_owned(),
        staging.display().to_string(),
        package_with_version(source, "=="),
    ];
    args.extend(source.extra_packages.iter().cloned());
    Ok(CommandSpec {
        program: resolve_python_with_pip().unwrap_or_else(|| "python3".to_owned()),
        args,
        env: BTreeMap::new(),
    })
}

fn cargo_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    CommandSpec {
        program: "cargo".to_owned(),
        args: vec![
            "install".to_owned(),
            "--root".to_owned(),
            staging.display().to_string(),
            "--version".to_owned(),
            source.version.clone(),
            source.package.clone(),
        ],
        env: BTreeMap::new(),
    }
}

fn golang_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    let mut env = BTreeMap::new();
    env.insert(
        "GOBIN".to_owned(),
        staging.join("bin").display().to_string(),
    );
    CommandSpec {
        program: "go".to_owned(),
        args: vec!["install".to_owned(), package_with_version(source, "@")],
        env,
    }
}

fn gem_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    CommandSpec {
        program: "gem".to_owned(),
        args: vec![
            "install".to_owned(),
            source.package.clone(),
            "-v".to_owned(),
            source.version.clone(),
            "--install-dir".to_owned(),
            staging.display().to_string(),
            "--bindir".to_owned(),
            staging.join("bin").display().to_string(),
        ],
        env: BTreeMap::new(),
    }
}

fn composer_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    CommandSpec {
        program: "composer".to_owned(),
        args: vec![
            "require".to_owned(),
            "--working-dir".to_owned(),
            staging.display().to_string(),
            package_with_version(source, ":"),
        ],
        env: BTreeMap::new(),
    }
}

fn luarocks_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    CommandSpec {
        program: "luarocks".to_owned(),
        args: vec![
            "install".to_owned(),
            "--tree".to_owned(),
            staging.display().to_string(),
            source.package.clone(),
            source.version.clone(),
        ],
        env: BTreeMap::new(),
    }
}

fn nuget_command(source: &NormalizedSource, staging: &Path) -> CommandSpec {
    CommandSpec {
        program: "nuget".to_owned(),
        args: vec![
            "install".to_owned(),
            source.package.clone(),
            "-Version".to_owned(),
            source.version.clone(),
            "-OutputDirectory".to_owned(),
            staging.display().to_string(),
        ],
        env: BTreeMap::new(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn source(ty: &str) -> NormalizedSource {
        NormalizedSource {
            id: format!("pkg:{ty}/ns/pkg@1.2.3"),
            source_type: ty.to_owned(),
            namespace: Some("ns".to_owned()),
            package: "pkg".to_owned(),
            version: "1.2.3".to_owned(),
            asset: None,
            extra_packages: vec!["extra".to_owned()],
            build_scripts: vec![],
            qualifiers: BTreeMap::new(),
            subpath: None,
            build: None,
            download: None,
        }
    }

    #[test]
    fn maps_managers() {
        assert_eq!(manager_for_source_type("npm"), Some("npm"));
        assert_eq!(manager_for_source_type("pypi"), Some("python3"));
        assert_eq!(manager_for_source_type("github"), None);
    }

    #[test]
    fn builds_commands_for_all_package_managers() {
        let staging = PathBuf::from("/tmp/stage");
        for ty in package_manager_types() {
            let spec = build_install_command(&source(ty), &staging).unwrap();
            assert!(!spec.program.is_empty());
            assert!(!spec.args.is_empty());
        }
        let npm = build_install_command(&source("npm"), &staging).unwrap();
        assert!(npm.args.contains(&"--prefix".to_owned()));
        assert!(npm.args.iter().any(|arg| arg == "ns/pkg@1.2.3"));
        assert!(npm.args.iter().any(|arg| arg == "extra"));
        let go = build_install_command(&source("golang"), &staging).unwrap();
        assert_eq!(go.env.get("GOBIN").unwrap(), "/tmp/stage/bin");
    }
}
