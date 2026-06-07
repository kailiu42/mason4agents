use serde::Serialize;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProgressStatus {
    Started,
    Running,
    Succeeded,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
pub struct ProgressMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ProgressEvent<'a> {
    pub kind: &'static str,
    pub schema_version: u8,
    pub operation: &'a str,
    pub phase: &'a str,
    pub status: ProgressStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<&'a str>,
    pub message: &'a str,
    pub elapsed_ms: u128,
    #[serde(flatten)]
    pub metrics: ProgressMetrics,
}

pub trait ProgressSink {
    fn event(
        &self,
        operation: &str,
        phase: &str,
        status: ProgressStatus,
        package: Option<&str>,
        message: &str,
    ) {
        self.event_with_metrics(
            operation,
            phase,
            status,
            package,
            message,
            ProgressMetrics::default(),
        );
    }

    fn event_with_metrics(
        &self,
        operation: &str,
        phase: &str,
        status: ProgressStatus,
        package: Option<&str>,
        message: &str,
        metrics: ProgressMetrics,
    );

    fn log(&self, _message: &str) {}

    fn log_path(&self) -> Option<&Path> {
        None
    }
}

#[derive(Debug, Default)]
pub struct NoProgressSink;

impl ProgressSink for NoProgressSink {
    fn event_with_metrics(
        &self,
        _operation: &str,
        _phase: &str,
        _status: ProgressStatus,
        _package: Option<&str>,
        _message: &str,
        _metrics: ProgressMetrics,
    ) {
    }
}

#[derive(Debug)]
pub struct StderrProgressSink {
    json: bool,
    started_at: Instant,
}

impl StderrProgressSink {
    pub fn new(json: bool) -> Self {
        Self {
            json,
            started_at: Instant::now(),
        }
    }
}

impl ProgressSink for StderrProgressSink {
    fn event_with_metrics(
        &self,
        operation: &str,
        phase: &str,
        status: ProgressStatus,
        package: Option<&str>,
        message: &str,
        metrics: ProgressMetrics,
    ) {
        if self.json {
            let event = ProgressEvent {
                kind: "progress",
                schema_version: 1,
                operation,
                phase,
                status,
                package,
                message,
                elapsed_ms: self.started_at.elapsed().as_millis(),
                metrics,
            };
            let mut stderr = io::stderr().lock();
            let _ = serde_json::to_writer(&mut stderr, &event);
            let _ = writeln!(stderr);
            return;
        }

        match package {
            Some(package) => eprintln!("[{operation}] {package}: {message}"),
            None => eprintln!("[{operation}] {message}"),
        }
    }
}

pub struct OperationProgressSink<'a> {
    inner: &'a dyn ProgressSink,
    log_path: PathBuf,
    file: Mutex<File>,
    started_at: Instant,
}

impl<'a> OperationProgressSink<'a> {
    pub fn new(
        inner: &'a dyn ProgressSink,
        logs_dir: &Path,
        operation: &str,
        label: &str,
    ) -> io::Result<Self> {
        let dir = logs_dir.join(sanitize_log_dir_component(operation));
        fs::create_dir_all(&dir)?;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let filename = format!(
            "{}-{}-{}.log",
            millis,
            std::process::id(),
            sanitize_log_component(label)
        );
        let log_path = dir.join(filename);
        let file = File::create(&log_path)?;
        Ok(Self {
            inner,
            log_path,
            file: Mutex::new(file),
            started_at: Instant::now(),
        })
    }
}

impl ProgressSink for OperationProgressSink<'_> {
    fn event_with_metrics(
        &self,
        operation: &str,
        phase: &str,
        status: ProgressStatus,
        package: Option<&str>,
        message: &str,
        metrics: ProgressMetrics,
    ) {
        self.write_log_line(&format!(
            "[{}ms] event operation={operation} phase={phase} status={status:?} package={} message={}",
            self.started_at.elapsed().as_millis(),
            package.unwrap_or("-"),
            message
        ));
        self.inner
            .event_with_metrics(operation, phase, status, package, message, metrics);
    }

    fn log(&self, message: &str) {
        self.write_log_line(message);
        self.inner.log(message);
    }

    fn log_path(&self) -> Option<&Path> {
        Some(&self.log_path)
    }
}

impl OperationProgressSink<'_> {
    fn write_log_line(&self, message: &str) {
        if let Ok(mut file) = self.file.lock() {
            let _ = writeln!(file, "{message}");
        }
    }
}

fn sanitize_log_dir_component(value: &str) -> String {
    let sanitized = sanitize_log_component(value);
    if sanitized == "." || sanitized == ".." || sanitized.chars().all(|ch| ch == '.') {
        "operation".to_owned()
    } else {
        sanitized
    }
}

fn sanitize_log_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(80));
    for ch in value.chars().take(80) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        "command".to_owned()
    } else {
        out
    }
}

pub fn emit_error(
    progress: &dyn ProgressSink,
    operation: &str,
    phase: &str,
    package: Option<&str>,
    err: &impl fmt::Display,
) {
    let message = err.to_string();
    progress.event(operation, phase, ProgressStatus::Failed, package, &message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn sanitizes_operation_log_directory_component() {
        assert_eq!(sanitize_log_dir_component("../install"), "..-install");
        assert_eq!(sanitize_log_dir_component(".."), "operation");
        assert_eq!(sanitize_log_dir_component("install"), "install");
    }

    #[derive(Default)]
    struct CaptureSink {
        messages: Mutex<Vec<String>>,
    }

    impl ProgressSink for CaptureSink {
        fn event_with_metrics(
            &self,
            _operation: &str,
            _phase: &str,
            _status: ProgressStatus,
            _package: Option<&str>,
            message: &str,
            _metrics: ProgressMetrics,
        ) {
            self.messages.lock().unwrap().push(message.to_owned());
        }
    }

    #[test]
    fn failed_progress_event_does_not_repeat_full_log_hint() {
        let tmp = tempfile::tempdir().unwrap();
        let capture = CaptureSink::default();
        let sink = OperationProgressSink::new(&capture, tmp.path(), "install", "pkg").unwrap();
        sink.event("install", "nested", ProgressStatus::Failed, None, "failed");
        let messages = capture.messages.lock().unwrap();
        assert_eq!(messages.as_slice(), &["failed".to_owned()]);
    }
}
