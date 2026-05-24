use serde::Serialize;
use serde_json::json;
use std::io;

#[derive(Debug, thiserror::Error)]
pub enum M4aError {
    #[error("{0}")]
    Message(String),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("package not found: {0}")]
    PackageNotFound(String),
    #[error("unsupported platform target for package {package}; available targets: {targets:?}")]
    UnsupportedTarget {
        package: String,
        targets: Vec<String>,
    },
    #[error("external package manager '{manager}' is required for {source_type} packages")]
    MissingManager {
        manager: String,
        source_type: String,
    },
    #[error("build scripts are disabled for package {package}; rerun with --allow-build-scripts to execute: {scripts:?}")]
    BuildScriptsDisabled {
        package: String,
        scripts: Vec<String>,
    },
    #[error("registry cache is missing; run mason4agents refresh first")]
    RegistryCacheMissing,
    #[error("registry cache checksum mismatch")]
    RegistryChecksumMismatch,
    #[error("invalid package url: {0}")]
    InvalidPurl(String),
    #[error("unsafe archive entry: {0}")]
    UnsafeArchiveEntry(String),
    #[error("command failed: {program} exited with {status}: {stderr}")]
    CommandFailed {
        program: String,
        status: i32,
        stderr: String,
    },
}

pub type Result<T> = std::result::Result<T, M4aError>;

impl M4aError {
    pub fn code(&self) -> &'static str {
        match self {
            M4aError::Message(_) => "error",
            M4aError::Io(_) => "io_error",
            M4aError::Http(_) => "http_error",
            M4aError::Json(_) => "json_error",
            M4aError::Yaml(_) => "yaml_error",
            M4aError::Zip(_) => "zip_error",
            M4aError::PackageNotFound(_) => "package_not_found",
            M4aError::UnsupportedTarget { .. } => "unsupported_target",
            M4aError::MissingManager { .. } => "missing_manager",
            M4aError::BuildScriptsDisabled { .. } => "build_scripts_disabled",
            M4aError::RegistryCacheMissing => "registry_cache_missing",
            M4aError::RegistryChecksumMismatch => "registry_checksum_mismatch",
            M4aError::InvalidPurl(_) => "invalid_purl",
            M4aError::UnsafeArchiveEntry(_) => "unsafe_archive_entry",
            M4aError::CommandFailed { .. } => "command_failed",
        }
    }
}

pub fn success_json<T: Serialize>(data: T) -> serde_json::Value {
    json!({ "ok": true, "data": data })
}

pub fn error_json(err: &M4aError) -> serde_json::Value {
    json!({
        "ok": false,
        "error": {
            "code": err.code(),
            "message": err.to_string()
        }
    })
}

pub fn msg<S: Into<String>>(message: S) -> M4aError {
    M4aError::Message(message.into())
}
