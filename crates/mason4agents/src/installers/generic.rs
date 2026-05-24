use crate::package_spec::NormalizedSource;
use crate::types::{msg, Result};

pub fn asset_locator(source: &NormalizedSource, file: Option<&str>) -> Result<String> {
    if let Some(file) = file {
        return Ok(file.to_owned());
    }
    // Fall back to source.download if no source.asset.file
    if let Some(download) = &source.download {
        return Ok(download.file.clone());
    }
    Err(msg(format!(
        "generic package {} must define source.asset.file or source.download",
        source.id
    )))
}
