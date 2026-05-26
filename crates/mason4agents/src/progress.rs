use serde::Serialize;
use std::fmt;
use std::io::{self, Write};
use std::time::Instant;

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
