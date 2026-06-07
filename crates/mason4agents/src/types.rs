use serde::Serialize;
use serde_json::json;
use std::io;
use std::path::PathBuf;

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
    #[error("command failed: {program} exited with {status}: {summary}")]
    CommandFailed {
        program: String,
        status: i32,
        summary: String,
    },
    #[error("{source}\nFull log: {}", log_path.display())]
    WithLog {
        source: Box<M4aError>,
        log_path: PathBuf,
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
            M4aError::WithLog { source, .. } => source.code(),
        }
    }

    pub fn with_log(self, log_path: Option<PathBuf>) -> Self {
        match (self, log_path) {
            (M4aError::WithLog { source, log_path }, _) => M4aError::WithLog { source, log_path },
            (err, Some(log_path)) => M4aError::WithLog {
                source: Box::new(err),
                log_path,
            },
            (err, None) => err,
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

pub fn command_failure_summary(stdout: &[u8], stderr: &[u8]) -> String {
    let mut selected = Vec::new();
    push_matching_summary_lines(&mut selected, stderr, 6);
    if selected.len() < 6 {
        push_matching_summary_lines(&mut selected, stdout, 6);
    }
    let summary = if selected.is_empty() {
        let stderr_text = String::from_utf8_lossy(stderr);
        let stdout_text = String::from_utf8_lossy(stdout);
        let mut fallback = Vec::new();
        for line in stderr_text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            fallback.push(line);
            if fallback.len() == 6 {
                break;
            }
        }
        if fallback.len() < 6 {
            for line in stdout_text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                fallback.push(line);
                if fallback.len() == 6 {
                    break;
                }
            }
        }
        if fallback.is_empty() {
            "no output".to_owned()
        } else {
            fallback.join(" | ")
        }
    } else {
        selected.join(" | ")
    };
    truncate_chars(&summary, 800)
}

fn push_matching_summary_lines(out: &mut Vec<String>, bytes: &[u8], max: usize) {
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let lower = line.to_ascii_lowercase();
        if lower.contains("error")
            || lower.contains("failed")
            || lower.contains("compilation")
            || lower.contains("exception")
        {
            out.push(line.to_owned());
            if out.len() == max {
                break;
            }
        }
    }
}

pub fn command_output_for_log(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = stdout.trim_end();
    let stderr = stderr.trim_end();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => "no output".to_owned(),
        (false, true) => format!("stdout:\n{stdout}"),
        (true, false) => format!("stderr:\n{stderr}"),
        (false, false) => format!("stdout:\n{stdout}\nstderr:\n{stderr}"),
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max_chars {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

pub fn msg<S: Into<String>>(message: S) -> M4aError {
    M4aError::Message(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_failure_summary_fallback_prefers_stderr() {
        let summary =
            command_failure_summary(b"stdout one\nstdout two\n", b"stderr one\nstderr two\n");
        assert_eq!(summary, "stderr one | stderr two | stdout one | stdout two");
    }

    #[test]
    fn command_failure_summary_keyword_matches_prefer_stderr() {
        let summary = command_failure_summary(
            b"error stdout 1\nerror stdout 2\nerror stdout 3\nerror stdout 4\nerror stdout 5\nerror stdout 6\n",
            b"fatal stderr error\n",
        );
        assert!(summary.starts_with("fatal stderr error"));
        assert!(!summary.contains("error stdout 6"));
    }
}
