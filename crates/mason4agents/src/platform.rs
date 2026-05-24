use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Platform {
    pub os: String,
    pub arch: String,
    pub libc: Option<String>,
}

impl Platform {
    pub fn current() -> Self {
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(unix) {
            "unix"
        } else {
            std::env::consts::OS
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let libc = if cfg!(target_os = "linux") {
            if cfg!(target_env = "musl") {
                Some("musl".to_owned())
            } else {
                Some("gnu".to_owned())
            }
        } else {
            None
        };
        Self {
            os: os.to_owned(),
            arch: arch.to_owned(),
            libc,
        }
    }

    pub fn new(os: &str, arch: &str, libc: Option<&str>) -> Self {
        Self {
            os: os.to_owned(),
            arch: arch.to_owned(),
            libc: libc.map(str::to_owned),
        }
    }

    pub fn candidates(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(libc) = &self.libc {
            out.push(format!("{}_{}_{}", self.os, self.arch, libc));
        }
        out.push(format!("{}_{}", self.os, self.arch));
        out.push(self.os.clone());
        if self.os == "linux" || self.os == "darwin" || self.os == "unix" {
            out.push("unix".to_owned());
        }
        out.dedup();
        out
    }

    pub fn select<'a, T>(&self, targets: &'a BTreeMap<String, T>) -> Option<(&'a str, &'a T)> {
        for candidate in self.candidates() {
            if let Some(value) = targets.get(&candidate) {
                return Some((
                    targets
                        .get_key_value(&candidate)
                        .expect("checked exists")
                        .0
                        .as_str(),
                    value,
                ));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_gnu_precedence() {
        let p = Platform::new("linux", "x64", Some("gnu"));
        assert_eq!(
            p.candidates(),
            vec!["linux_x64_gnu", "linux_x64", "linux", "unix"]
        );
    }

    #[test]
    fn darwin_precedence() {
        let p = Platform::new("darwin", "arm64", None);
        assert_eq!(p.candidates(), vec!["darwin_arm64", "darwin", "unix"]);
    }

    #[test]
    fn selects_most_specific_target() {
        let p = Platform::new("linux", "x64", Some("gnu"));
        let targets = BTreeMap::from([
            ("linux".to_owned(), 1),
            ("linux_x64".to_owned(), 2),
            ("linux_x64_gnu".to_owned(), 3),
        ]);
        assert_eq!(p.select(&targets), Some(("linux_x64_gnu", &3)));
    }

    #[test]
    fn falls_back_to_unix() {
        let p = Platform::new("linux", "arm64", Some("musl"));
        let targets = BTreeMap::from([("unix".to_owned(), 7)]);
        assert_eq!(p.select(&targets), Some(("unix", &7)));
    }
}
