use crate::progress::{emit_error, NoProgressSink, ProgressMetrics, ProgressSink, ProgressStatus};
use crate::types::{msg, M4aError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const DOWNLOAD_PROGRESS_STEP_BYTES: u64 = 64 * 1024;

pub fn download_to_cache(locator: &str, downloads_dir: &Path) -> Result<PathBuf> {
    let progress = NoProgressSink;
    download_to_cache_with_progress(locator, downloads_dir, "download", None, &progress)
}

pub fn download_to_cache_with_progress(
    locator: &str,
    downloads_dir: &Path,
    operation: &str,
    package: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<PathBuf> {
    let result = (|| -> Result<PathBuf> {
        fs::create_dir_all(downloads_dir)?;
        if let Some(path) = local_path(locator) {
            progress.event(
                operation,
                "download",
                ProgressStatus::Running,
                package,
                "copying local file to cache",
            );
            let filename = path
                .file_name()
                .ok_or_else(|| msg(format!("download path has no filename: {locator}")))?;
            let dest = downloads_dir.join(filename);
            fs::copy(path, &dest)?;
            return Ok(dest);
        }
        download_remote_to_cache_with_progress(locator, downloads_dir, operation, package, progress)
    })();
    match &result {
        Ok(_) => progress.event(
            operation,
            "download",
            ProgressStatus::Succeeded,
            package,
            "source cached",
        ),
        Err(err) => emit_error(progress, operation, "download", package, err),
    }
    result
}

fn remote_cache_path(locator: &str, downloads_dir: &Path) -> Result<PathBuf> {
    let digest = hex::encode(Sha256::digest(locator.as_bytes()));
    let dir = downloads_dir.join(&digest[..16]);
    let clean_locator = locator
        .split('?')
        .next()
        .unwrap_or(locator)
        .split('#')
        .next()
        .unwrap_or(locator);
    let filename = clean_locator
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| hex::encode(Sha256::digest(locator.as_bytes())));
    Ok(dir.join(filename))
}

fn temp_cache_path(dest: &Path, attempt: usize) -> Result<PathBuf> {
    let filename = dest
        .file_name()
        .ok_or_else(|| {
            msg(format!(
                "download cache path has no filename: {}",
                dest.display()
            ))
        })?
        .to_string_lossy();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(dest.with_file_name(format!(
        ".{filename}.{}.{}.tmp",
        std::process::id(),
        nonce + attempt as u128,
    )))
}

fn download_remote_to_cache_with_progress(
    locator: &str,
    downloads_dir: &Path,
    operation: &str,
    package: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<PathBuf> {
    progress.event(
        operation,
        "download",
        ProgressStatus::Started,
        package,
        "fetching remote source",
    );
    let dest = remote_cache_path(locator, downloads_dir)?;
    let dir = dest.parent().ok_or_else(|| {
        msg(format!(
            "download cache path has no parent: {}",
            dest.display()
        ))
    })?;
    fs::create_dir_all(dir)?;

    let client = reqwest::blocking::Client::builder()
        .user_agent("mason4agents/0.1")
        .build()?;
    let mut last_error: Option<M4aError> = None;
    for attempt in 0..3 {
        let message = format!("download attempt {}/3", attempt + 1);
        progress.event(
            operation,
            "download",
            ProgressStatus::Running,
            package,
            &message,
        );
        match client
            .get(locator)
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(mut response) => {
                let reporter = DownloadProgressReporter::new(
                    operation,
                    package,
                    progress,
                    response.content_length(),
                );
                reporter.emit_started();
                let tmp = temp_cache_path(&dest, attempt)?;
                match stream_response_to_temp_file(&mut response, &tmp, reporter) {
                    Ok((downloaded, mut reporter)) => {
                        if let Err(err) = fs::rename(&tmp, &dest) {
                            cleanup_temp_file(&tmp);
                            last_error = Some(err.into());
                        } else {
                            reporter.emit_succeeded(downloaded);
                            return Ok(dest);
                        }
                    }
                    Err(err) => {
                        cleanup_temp_file(&tmp);
                        last_error = Some(err);
                    }
                }
            }
            Err(err) => {
                last_error = Some(err.into());
            }
        }
        if attempt < 2 {
            progress.event(
                operation,
                "download",
                ProgressStatus::Running,
                package,
                "download attempt failed; retrying",
            );
            let attempt_delay = u64::try_from(attempt + 1).expect("small retry count");
            thread::sleep(Duration::from_millis(150 * attempt_delay));
        }
    }
    let err = last_error.expect("loop attempted at least once");
    Err(err)
}

fn stream_response_to_temp_file<'a>(
    response: &mut reqwest::blocking::Response,
    tmp: &Path,
    reporter: DownloadProgressReporter<'a>,
) -> Result<(u64, DownloadProgressReporter<'a>)> {
    let file = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    let mut download = DownloadFile {
        file,
        downloaded: 0,
        reporter,
    };
    io::copy(response, &mut download)?;
    download.file.flush()?;
    Ok((download.downloaded, download.reporter))
}

fn cleanup_temp_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

pub fn fetch_bytes(locator: &str) -> Result<Vec<u8>> {
    let progress = NoProgressSink;
    fetch_bytes_with_progress(locator, "download", None, &progress)
}

pub fn fetch_bytes_with_progress(
    locator: &str,
    operation: &str,
    package: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<Vec<u8>> {
    if let Some(path) = local_path(locator) {
        progress.event(
            operation,
            "download",
            ProgressStatus::Running,
            package,
            "reading local file",
        );
        return Ok(fs::read(path)?);
    }
    progress.event(
        operation,
        "download",
        ProgressStatus::Started,
        package,
        "fetching remote source",
    );
    let client = reqwest::blocking::Client::builder()
        .user_agent("mason4agents/0.1")
        .build()?;
    let mut last_error = None;
    for attempt in 0..3 {
        let message = format!("download attempt {}/3", attempt + 1);
        progress.event(
            operation,
            "download",
            ProgressStatus::Running,
            package,
            &message,
        );
        match client
            .get(locator)
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(mut response) => {
                let mut download =
                    DownloadBuffer::new(operation, package, progress, response.content_length());
                download.reporter.emit_started();
                match response.copy_to(&mut download) {
                    Ok(_) => {
                        download.reporter.emit_succeeded(download.downloaded);
                        return Ok(download.finish());
                    }
                    Err(err) => {
                        last_error = Some(err);
                    }
                }
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
        if attempt < 2 {
            progress.event(
                operation,
                "download",
                ProgressStatus::Running,
                package,
                "download attempt failed; retrying",
            );
            let attempt_delay = u64::try_from(attempt + 1).expect("small retry count");
            thread::sleep(Duration::from_millis(150 * attempt_delay));
        }
    }
    let err = last_error.expect("loop attempted at least once");
    emit_error(progress, operation, "download", package, &err);
    Err(err.into())
}

pub fn local_path(locator: &str) -> Option<&Path> {
    if let Some(rest) = locator.strip_prefix("file://") {
        return Some(Path::new(rest));
    }
    let path = Path::new(locator);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

struct DownloadBuffer<'a> {
    bytes: Vec<u8>,
    downloaded: u64,
    reporter: DownloadProgressReporter<'a>,
}

impl<'a> DownloadBuffer<'a> {
    fn new(
        operation: &'a str,
        package: Option<&'a str>,
        progress: &'a dyn ProgressSink,
        total_bytes: Option<u64>,
    ) -> Self {
        let mut bytes = Vec::new();
        if let Some(total_bytes) = total_bytes.and_then(|value| usize::try_from(value).ok()) {
            bytes.reserve(total_bytes);
        }
        Self {
            bytes,
            downloaded: 0,
            reporter: DownloadProgressReporter::new(operation, package, progress, total_bytes),
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for DownloadBuffer<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes.extend_from_slice(buf);
        self.downloaded += u64::try_from(buf.len()).expect("buffer length fits into u64");
        self.reporter.maybe_emit(self.downloaded);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct DownloadFile<'a> {
    file: fs::File,
    downloaded: u64,
    reporter: DownloadProgressReporter<'a>,
}

impl Write for DownloadFile<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        self.downloaded += u64::try_from(written).expect("written length fits into u64");
        self.reporter.maybe_emit(self.downloaded);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

struct DownloadProgressReporter<'a> {
    operation: &'a str,
    package: Option<&'a str>,
    progress: &'a dyn ProgressSink,
    total_bytes: Option<u64>,
    started_at: Instant,
    last_emit_at: Instant,
    last_emit_bytes: u64,
}

impl<'a> DownloadProgressReporter<'a> {
    fn new(
        operation: &'a str,
        package: Option<&'a str>,
        progress: &'a dyn ProgressSink,
        total_bytes: Option<u64>,
    ) -> Self {
        let now = Instant::now();
        Self {
            operation,
            package,
            progress,
            total_bytes,
            started_at: now,
            last_emit_at: now,
            last_emit_bytes: 0,
        }
    }

    fn emit_started(&self) {
        let metrics = ProgressMetrics {
            total_bytes: self.total_bytes,
            ..ProgressMetrics::default()
        };
        let message = match self.total_bytes {
            Some(total_bytes) => format!("starting download of {}", format_byte_count(total_bytes)),
            None => "starting download".to_owned(),
        };
        self.progress.event_with_metrics(
            self.operation,
            "download",
            ProgressStatus::Started,
            self.package,
            &message,
            metrics,
        );
    }

    fn maybe_emit(&mut self, downloaded: u64) {
        if downloaded == self.last_emit_bytes {
            return;
        }
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last_emit_at);
        let bytes_delta = downloaded.saturating_sub(self.last_emit_bytes);
        if elapsed < DOWNLOAD_PROGRESS_INTERVAL && bytes_delta < DOWNLOAD_PROGRESS_STEP_BYTES {
            return;
        }
        self.emit(downloaded, now, ProgressStatus::Running);
    }

    fn emit_succeeded(&mut self, downloaded: u64) {
        self.emit(downloaded, Instant::now(), ProgressStatus::Succeeded);
    }

    fn emit(&mut self, downloaded: u64, now: Instant, status: ProgressStatus) {
        let speed = speed_between(self.last_emit_at, self.last_emit_bytes, now, downloaded)
            .or_else(|| speed_between(self.started_at, 0, now, downloaded));
        let metrics = ProgressMetrics {
            total_bytes: self.total_bytes,
            downloaded_bytes: Some(downloaded),
            download_percent: download_percent(downloaded, self.total_bytes),
            bytes_per_second: speed,
        };
        let message = format_download_message(downloaded, self.total_bytes, speed);
        self.progress.event_with_metrics(
            self.operation,
            "download",
            status,
            self.package,
            &message,
            metrics,
        );
        self.last_emit_at = now;
        self.last_emit_bytes = downloaded;
    }
}

fn speed_between(
    start_at: Instant,
    start_bytes: u64,
    end_at: Instant,
    end_bytes: u64,
) -> Option<u64> {
    let elapsed = end_at.saturating_duration_since(start_at);
    let bytes = end_bytes.saturating_sub(start_bytes);
    if elapsed.is_zero() || bytes == 0 {
        return None;
    }
    Some((bytes as f64 / elapsed.as_secs_f64()).round() as u64)
}

fn download_percent(downloaded: u64, total_bytes: Option<u64>) -> Option<f64> {
    total_bytes.map(|total| {
        if total == 0 {
            100.0
        } else {
            ((downloaded as f64 / total as f64) * 100.0).min(100.0)
        }
    })
}

fn format_download_message(
    downloaded: u64,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
) -> String {
    let mut message = match total_bytes {
        Some(total_bytes) => format!(
            "downloaded {} / {} ({:.1}%)",
            format_byte_count(downloaded),
            format_byte_count(total_bytes),
            download_percent(downloaded, Some(total_bytes)).unwrap_or(0.0),
        ),
        None => format!("downloaded {}", format_byte_count(downloaded)),
    };
    if let Some(bytes_per_second) = bytes_per_second {
        message.push_str(" at ");
        message.push_str(&format_byte_count(bytes_per_second));
        message.push_str("/s");
    }
    message
}

fn format_byte_count(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    if value < 10.0 {
        format!("{value:.1} {}", UNITS[unit_index])
    } else {
        format!("{value:.0} {}", UNITS[unit_index])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::{ProgressMetrics, ProgressStatus};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    struct RecordedEvent {
        status: ProgressStatus,
        message: String,
        metrics: ProgressMetrics,
    }

    #[derive(Debug, Default)]
    struct CollectingSink {
        events: Mutex<Vec<RecordedEvent>>,
    }

    impl CollectingSink {
        fn take(&self) -> Vec<RecordedEvent> {
            let mut guard = self.events.lock().expect("progress events lock");
            std::mem::take(&mut *guard)
        }
    }

    impl ProgressSink for CollectingSink {
        fn event_with_metrics(
            &self,
            _operation: &str,
            _phase: &str,
            status: ProgressStatus,
            _package: Option<&str>,
            message: &str,
            metrics: ProgressMetrics,
        ) {
            self.events
                .lock()
                .expect("progress events lock")
                .push(RecordedEvent {
                    status,
                    message: message.to_owned(),
                    metrics,
                });
        }
    }

    #[test]
    fn fetch_bytes_reports_total_percent_and_speed() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let addr = listener.local_addr().expect("listener addr");
        let body_chunks = [
            b"abcd".repeat(1024),
            b"efgh".repeat(1024),
            b"ijkl".repeat(1024),
        ];
        let total_bytes = body_chunks.iter().map(Vec::len).sum::<usize>();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {total_bytes}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            )
            .expect("write response headers");
            stream.flush().expect("flush response headers");
            for chunk in body_chunks {
                stream.write_all(&chunk).expect("write response chunk");
                stream.flush().expect("flush response chunk");
                thread::sleep(Duration::from_millis(140));
            }
        });

        let progress = CollectingSink::default();
        let locator = format!("http://{addr}/archive.zip");
        let bytes = fetch_bytes_with_progress(&locator, "install", Some("demo"), &progress)
            .expect("download bytes");
        server.join().expect("server thread");

        assert_eq!(bytes.len(), total_bytes);
        let events = progress.take();
        let metric_events = events
            .iter()
            .filter(|event| event.metrics.downloaded_bytes.is_some())
            .collect::<Vec<_>>();
        assert!(!metric_events.is_empty());

        let final_event = metric_events.last().expect("final metric event");
        assert_eq!(final_event.status, ProgressStatus::Succeeded);
        assert_eq!(final_event.metrics.total_bytes, Some(total_bytes as u64));
        assert_eq!(
            final_event.metrics.downloaded_bytes,
            Some(total_bytes as u64)
        );
        assert!(
            final_event
                .metrics
                .download_percent
                .expect("download percent")
                >= 100.0
        );
        assert!(
            final_event
                .metrics
                .bytes_per_second
                .expect("download speed")
                > 0
        );
        assert!(final_event.message.contains("100.0%"));
        assert!(final_event.message.contains("/s"));
    }

    #[test]
    fn download_to_cache_streams_remote_body_to_final_file_with_progress() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let downloads_dir = tmp.path().join("downloads");
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let addr = listener.local_addr().expect("listener addr");
        let body_chunks = [
            b"abcd".repeat(16 * 1024),
            b"efgh".repeat(16 * 1024),
            b"ijkl".repeat(16 * 1024),
        ];
        let expected = body_chunks.concat();
        let total_bytes = expected.len();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {total_bytes}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            )
            .expect("write response headers");
            stream.flush().expect("flush response headers");
            for chunk in body_chunks {
                stream.write_all(&chunk).expect("write response chunk");
                stream.flush().expect("flush response chunk");
            }
        });

        let progress = CollectingSink::default();
        let locator = format!("http://{addr}/archive.zip");
        let cached = download_to_cache_with_progress(
            &locator,
            &downloads_dir,
            "install",
            Some("demo"),
            &progress,
        )
        .expect("download cache");
        server.join().expect("server thread");

        assert_eq!(fs::read(&cached).expect("cached bytes"), expected);
        assert_eq!(cached, remote_cache_path(&locator, &downloads_dir).unwrap());
        assert!(!fs::read_dir(cached.parent().expect("cache parent"))
            .expect("cache dir")
            .any(|entry| entry
                .expect("cache entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));

        let events = progress.take();
        let final_event = events
            .iter()
            .rev()
            .find(|event| event.metrics.downloaded_bytes.is_some())
            .expect("final metric event");
        assert_eq!(final_event.status, ProgressStatus::Succeeded);
        assert_eq!(
            final_event.metrics.downloaded_bytes,
            Some(total_bytes as u64)
        );
        assert_eq!(final_event.metrics.total_bytes, Some(total_bytes as u64));
    }

    #[test]
    fn failed_download_to_cache_removes_temp_file_and_does_not_create_final_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let downloads_dir = tmp.path().join("downloads");
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\nshort",
                    )
                    .expect("write short response");
                stream.flush().expect("flush short response");
            }
        });

        let progress = CollectingSink::default();
        let locator = format!("http://{addr}/broken.zip");
        let dest = remote_cache_path(&locator, &downloads_dir).expect("cache path");
        let result = download_to_cache_with_progress(
            &locator,
            &downloads_dir,
            "install",
            Some("demo"),
            &progress,
        );
        server.join().expect("server thread");

        assert!(result.is_err());
        assert!(!dest.exists());
        let cache_dir = dest.parent().expect("cache parent");
        if cache_dir.exists() {
            assert!(fs::read_dir(cache_dir).expect("cache dir").next().is_none());
        }
    }
}
