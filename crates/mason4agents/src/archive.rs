use crate::types::{msg, M4aError, Result};
use flate2::read::GzDecoder;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

pub fn split_archive_spec(spec: &str) -> (&str, Option<&str>) {
    for marker in [".tar.gz:", ".tgz:", ".zip:", ".vsix:", ".tar:", ".gz:"] {
        if let Some(idx) = spec.find(marker) {
            let split = idx + marker.len() - 1;
            return (&spec[..split], Some(&spec[split + 1..]));
        }
    }
    (spec, None)
}

pub fn is_archive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".vsix")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar")
        || lower.ends_with(".gz")
}

pub fn unpack_or_copy(path: &Path, dest: &Path, strip_prefix: Option<&str>) -> Result<()> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if is_archive_name(name) {
        if strip_prefix.is_some()
            && name.ends_with(".gz")
            && !name.ends_with(".tar.gz")
            && !name.ends_with(".tgz")
        {
            return Err(msg("strip_prefix not supported for gzip files"));
        }
        unpack_archive(path, dest, strip_prefix)
    } else {
        fs::create_dir_all(dest)?;
        let filename = path
            .file_name()
            .ok_or_else(|| msg("downloaded file has no filename"))?;
        fs::copy(path, dest.join(filename))?;
        Ok(())
    }
}

pub fn unpack_archive(path: &Path, dest: &Path, strip_prefix: Option<&str>) -> Result<()> {
    fs::create_dir_all(dest)?;
    let lower = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".vsix") {
        unpack_zip(path, dest, strip_prefix)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let file = File::open(path)?;
        let decoder = GzDecoder::new(file);
        unpack_tar(decoder, dest, strip_prefix)
    } else if lower.ends_with(".tar") {
        let file = File::open(path)?;
        unpack_tar(file, dest, strip_prefix)
    } else if lower.ends_with(".gz") {
        unpack_gz(path, dest)
    } else {
        Err(msg(format!(
            "unsupported archive format: {}",
            path.display()
        )))
    }
}

fn unpack_zip(path: &Path, dest: &Path, strip_prefix: Option<&str>) -> Result<()> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut written = HashSet::new();
    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| M4aError::UnsafeArchiveEntry(entry.name().to_owned()))?
            .to_path_buf();
        let Some(rel) = apply_strip_prefix(&enclosed, strip_prefix)? else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = safe_join(dest, &rel)?;
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if !written.insert(rel.clone()) {
            return Err(M4aError::UnsafeArchiveEntry(format!(
                "duplicate archive entry {}",
                rel.display()
            )));
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = File::create(&out)?;
        io::copy(&mut entry, &mut output)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out, fs::Permissions::from_mode(mode))?;
        }
        count += 1;
    }
    if count == 0 {
        return Err(msg(
            "archive did not contain files matching requested prefix",
        ));
    }
    Ok(())
}

fn unpack_tar<R: io::Read>(reader: R, dest: &Path, strip_prefix: Option<&str>) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut written = HashSet::new();
    let mut count = 0usize;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(M4aError::UnsafeArchiveEntry(format!(
                "link entry {}",
                entry.path()?.display()
            )));
        }
        let path = entry.path()?.to_path_buf();
        let Some(rel) = apply_strip_prefix(&path, strip_prefix)? else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = safe_join(dest, &rel)?;
        if kind.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if !written.insert(rel.clone()) {
            return Err(M4aError::UnsafeArchiveEntry(format!(
                "duplicate archive entry {}",
                rel.display()
            )));
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&out)?;
        count += 1;
    }
    if count == 0 {
        return Err(msg(
            "archive did not contain files matching requested prefix",
        ));
    }
    Ok(())
}

fn unpack_gz(path: &Path, dest: &Path) -> Result<()> {
    let file = File::open(path)?;
    let mut decoder = GzDecoder::new(file);
    let stem = path
        .file_stem()
        .ok_or_else(|| msg("gzip file has no stem"))?;
    let out = safe_join(dest, Path::new(stem))?;
    let mut output = File::create(out)?;
    io::copy(&mut decoder, &mut output)?;
    Ok(())
}

fn apply_strip_prefix(path: &Path, strip_prefix: Option<&str>) -> Result<Option<PathBuf>> {
    let Some(prefix) = strip_prefix else {
        return Ok(Some(path.to_path_buf()));
    };
    let prefix = Path::new(prefix);
    match path.strip_prefix(prefix) {
        Ok(rest) => Ok(Some(rest.to_path_buf())),
        Err(_) => Ok(None),
    }
}

pub fn safe_join(dest: &Path, rel: &Path) -> Result<PathBuf> {
    if rel.is_absolute() {
        return Err(M4aError::UnsafeArchiveEntry(rel.display().to_string()));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(M4aError::UnsafeArchiveEntry(rel.display().to_string()));
            }
        }
    }
    Ok(dest.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use tar::Builder;
    use zip::write::FileOptions;

    #[test]
    fn splits_archive_prefix_without_confusing_file_url() {
        assert_eq!(
            split_archive_spec("tool.zip:bin/"),
            ("tool.zip", Some("bin/"))
        );
        assert_eq!(
            split_archive_spec("file:///tmp/tool.zip"),
            ("file:///tmp/tool.zip", None)
        );
    }

    #[test]
    fn rejects_unsafe_join() {
        assert!(safe_join(Path::new("/tmp/out"), Path::new("../evil")).is_err());
        assert!(safe_join(Path::new("/tmp/out"), Path::new("/abs")).is_err());
    }

    #[test]
    fn unpacks_zip_and_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("ok.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("root/bin/tool", FileOptions::<()>::default())
                .unwrap();
            zip.write_all(b"#!/bin/sh\necho ok\n").unwrap();
            zip.finish().unwrap();
        }
        let out = tmp.path().join("out");
        unpack_archive(&zip_path, &out, Some("root/bin")).unwrap();
        assert!(out.join("tool").exists());

        let bad_zip = tmp.path().join("bad.zip");
        {
            let file = File::create(&bad_zip).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("../evil", FileOptions::<()>::default())
                .unwrap();
            zip.write_all(b"bad").unwrap();
            zip.finish().unwrap();
        }
        assert!(unpack_archive(&bad_zip, &tmp.path().join("bad-out"), None).is_err());
    }

    #[test]
    fn unpacks_tar_tgz_and_rejects_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let tar_path = tmp.path().join("ok.tar");
        {
            let file = File::create(&tar_path).unwrap();
            let mut tar = Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_path("pkg/bin/tool").unwrap();
            header.set_size(2);
            header.set_cksum();
            tar.append(&header, &b"ok"[..]).unwrap();
            tar.finish().unwrap();
        }
        unpack_archive(&tar_path, &tmp.path().join("tar-out"), Some("pkg/bin")).unwrap();
        assert!(tmp.path().join("tar-out/tool").exists());

        let tgz_path = tmp.path().join("ok.tgz");
        {
            let file = File::create(&tgz_path).unwrap();
            let encoder = GzEncoder::new(file, Compression::default());
            let mut tar = Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_path("pkg/file").unwrap();
            header.set_size(2);
            header.set_cksum();
            tar.append(&header, &b"ok"[..]).unwrap();
            tar.finish().unwrap();
        }
        unpack_archive(&tgz_path, &tmp.path().join("tgz-out"), Some("pkg")).unwrap();
        assert!(tmp.path().join("tgz-out/file").exists());

        let bad_tar = tmp.path().join("bad.tar");
        {
            let file = File::create(&bad_tar).unwrap();
            let mut tar = Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_path("link").unwrap();
            header.set_link_name("../evil").unwrap();
            header.set_size(0);
            header.set_cksum();
            tar.append(&header, io::empty()).unwrap();
            tar.finish().unwrap();
        }
        assert!(unpack_archive(&bad_tar, &tmp.path().join("bad-tar-out"), None).is_err());
    }

    #[test]
    fn unpacks_gz_single_file() {
        let tmp = tempfile::tempdir().unwrap();
        let gz_path = tmp.path().join("tool.gz");
        {
            let file = File::create(&gz_path).unwrap();
            let mut encoder = GzEncoder::new(file, Compression::default());
            encoder.write_all(b"ok").unwrap();
            encoder.finish().unwrap();
        }
        unpack_archive(&gz_path, &tmp.path().join("gz-out"), None).unwrap();
        assert!(tmp.path().join("gz-out/tool").exists());
    }
}
