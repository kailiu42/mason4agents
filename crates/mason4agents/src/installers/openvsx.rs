use crate::package_spec::NormalizedSource;
use crate::types::{msg, Result};

pub fn vsix_url(source: &NormalizedSource) -> Result<String> {
    let namespace = source
        .namespace
        .as_ref()
        .ok_or_else(|| msg("openvsx package source requires namespace"))?;
    Ok(format!(
        "https://open-vsx.org/api/{}/{}/{}/file/{}.{}-{}.vsix",
        namespace, source.package, source.version, namespace, source.package, source.version
    ))
}
