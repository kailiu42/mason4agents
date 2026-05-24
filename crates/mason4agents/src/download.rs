use crate::types::{msg, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub fn download_to_cache(locator: &str, downloads_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(downloads_dir)?;
    if let Some(path) = local_path(locator) {
        let filename = path
            .file_name()
            .ok_or_else(|| msg(format!("download path has no filename: {locator}")))?;
        let dest = downloads_dir.join(filename);
        fs::copy(path, &dest)?;
        return Ok(dest);
    }
    let bytes = fetch_bytes(locator)?;
    let digest = hex::encode(Sha256::digest(locator.as_bytes()));
    let dir = downloads_dir.join(&digest[..16]);
    fs::create_dir_all(&dir)?;
    // Strip query and fragment for filename derivation only
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
    let dest = dir.join(filename);
    let mut file = fs::File::create(&dest)?;
    file.write_all(&bytes)?;
    Ok(dest)
}

pub fn fetch_bytes(locator: &str) -> Result<Vec<u8>> {
    if let Some(path) = local_path(locator) {
        return Ok(fs::read(path)?);
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("mason4agents/0.1")
        .build()?;
    let mut last_error = None;
    for attempt in 0..3 {
        match client
            .get(locator)
            .send()
            .and_then(|r| r.error_for_status())
        {
            Ok(response) => return Ok(response.bytes()?.to_vec()),
            Err(err) => {
                last_error = Some(err);
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(150 * (attempt + 1)));
                }
            }
        }
    }
    Err(last_error.expect("loop attempted at least once").into())
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
