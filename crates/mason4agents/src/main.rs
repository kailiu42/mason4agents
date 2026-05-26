use clap::{Parser, Subcommand, ValueEnum};
use mason4agents::doctor::doctor;
use mason4agents::installer::Installer;
use mason4agents::paths::MasonPaths;
use mason4agents::platform::Platform;
use mason4agents::registry::{
    load_or_refresh, refresh_registry, search_packages, PackageSummary, RefreshSummary,
};
use mason4agents::store::{InstalledPackage, InstalledState};
use mason4agents::suggestions::{suggest_packages, SuggestionItem, SuggestionOptions};
use mason4agents::types::{error_json, success_json, M4aError, Result};
use serde::Serialize;
use serde_json::json;
use std::fmt::Write as FmtWrite;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "mason4agents",
    version,
    about = "Mason Registry powered tool installer for coding agents"
)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Refresh {
        #[arg(long)]
        registry: Option<String>,
    },
    Search {
        query: Option<String>,
        #[arg(long)]
        category: Option<String>,
        #[arg(long)]
        language: Option<String>,
        #[arg(long)]
        registry: Option<String>,
    },
    List {
        #[arg(long)]
        installed: bool,
        #[arg(long)]
        outdated: bool,
        #[arg(long)]
        registry: Option<String>,
    },
    #[command(hide = true)]
    Suggested {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        registry: Option<String>,
        #[arg(long)]
        refresh_suggestions: bool,
        #[arg(long, hide = true)]
        suggestions_source: Option<String>,
    },
    Install {
        packages: Vec<String>,
        #[arg(long)]
        registry: Option<String>,
        #[arg(long)]
        allow_build_scripts: bool,
    },
    Uninstall {
        packages: Vec<String>,
    },
    Update {
        packages: Vec<String>,
        #[arg(long)]
        registry: Option<String>,
        #[arg(long)]
        allow_build_scripts: bool,
    },
    Which {
        executable: String,
    },
    BinDir,
    Env {
        #[arg(long, value_enum)]
        shell: Shell,
    },
    Doctor,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Shell {
    Bash,
    Zsh,
    Fish,
    Powershell,
    Cmd,
    Json,
}

/// Output from a CLI command: JSON data + human-readable text.
struct Output {
    json: serde_json::Value,
    text: String,
}

impl Output {
    fn new<T: Serialize>(json: T, text: String) -> Self {
        Self {
            json: serde_json::to_value(json).expect("output serialization"),
            text,
        }
    }
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().collect();
    let is_json = raw_args.iter().any(|a| a == "--json");
    match Cli::try_parse() {
        Ok(cli) => match run(cli) {
            Ok(output) => {
                if is_json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&success_json(output.json))
                            .expect("serializes")
                    );
                } else {
                    println!("{}", output.text);
                }
                ExitCode::SUCCESS
            }
            Err(err) => {
                if is_json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&error_json(&err)).expect("serializes")
                    );
                } else {
                    eprintln!("Error: {err}");
                }
                ExitCode::from(1)
            }
        },
        Err(err) if is_json => {
            if err.kind() == clap::error::ErrorKind::DisplayHelp
                || err.kind() == clap::error::ErrorKind::DisplayVersion
            {
                eprintln!("{err}");
                return ExitCode::SUCCESS;
            }
            let msg = format!("{:?}", err);
            println!(
                r#"{{"ok":false,"error":{{"code":"parse_error","message":"clap: {}"}}}}"#,
                msg.replace('"', "\\\"")
            );
            ExitCode::from(2)
        }
        Err(err) => {
            if err.kind() == clap::error::ErrorKind::DisplayHelp
                || err.kind() == clap::error::ErrorKind::DisplayVersion
            {
                eprintln!("{err}");
                return ExitCode::SUCCESS;
            }
            eprintln!("{err}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<Output> {
    let paths = MasonPaths::from_env()?;
    let platform = Platform::current();
    match cli.command {
        Command::Refresh { registry } => {
            let result = refresh_registry(&paths, registry.as_deref())?;
            Ok(format_refresh(&result))
        }
        Command::Search {
            query,
            category,
            language,
            registry,
        } => {
            let cache = load_or_refresh(&paths, registry.as_deref())?;
            let state = InstalledState::load(&paths)?;
            let list = search_packages(
                &cache,
                &state,
                &platform,
                query.as_deref(),
                category.as_deref(),
                language.as_deref(),
            );
            Ok(format_package_list(&list))
        }
        Command::List {
            installed,
            outdated,
            registry,
        } => {
            let state = InstalledState::load(&paths)?;
            if installed {
                let list = state.packages.values().cloned().collect::<Vec<_>>();
                Ok(format_installed_list(&list))
            } else {
                let cache = load_or_refresh(&paths, registry.as_deref())?;
                let mut list = search_packages(&cache, &state, &platform, None, None, None);
                if outdated {
                    list.retain(|p| p.outdated);
                }
                Ok(format_package_list(&list))
            }
        }
        Command::Suggested {
            path,
            registry,
            refresh_suggestions,
            suggestions_source,
        } => {
            let cache = load_or_refresh(&paths, registry.as_deref())?;
            let state = InstalledState::load(&paths)?;
            let project_path = match path {
                Some(path) => path,
                None => std::env::current_dir()?,
            };
            let list = suggest_packages(
                &paths,
                &cache,
                &state,
                &platform,
                SuggestionOptions {
                    project_path: &project_path,
                    refresh_curated: refresh_suggestions,
                    curated_source: suggestions_source.as_deref(),
                },
            )?;
            Ok(format_suggestion_list(&list))
        }
        Command::Install {
            packages,
            registry,
            allow_build_scripts,
        } => {
            if packages.is_empty() {
                return Err(M4aError::Message(
                    "install requires at least one package".to_owned(),
                ));
            }
            let installer = Installer::new(paths, platform);
            let results =
                installer.install_requests(&packages, registry.as_deref(), allow_build_scripts)?;
            Ok(format_install_results(&results))
        }
        Command::Uninstall { packages } => {
            if packages.is_empty() {
                return Err(M4aError::Message(
                    "uninstall requires at least one package".to_owned(),
                ));
            }
            let installer = Installer::new(paths, platform);
            let results = installer.uninstall(&packages)?;
            Ok(format_uninstall_results(&results))
        }
        Command::Update {
            packages,
            registry,
            allow_build_scripts,
        } => {
            let installer = Installer::new(paths, platform);
            let results =
                installer.update_requests(&packages, registry.as_deref(), allow_build_scripts)?;
            Ok(format_install_results(&results))
        }
        Command::Which { executable } => {
            let installer = Installer::new(paths, platform);
            let result = installer.which(&executable)?;
            Ok(format_which(&result, &executable))
        }
        Command::BinDir => {
            let text = format!("{}", paths.bin_dir.display());
            Ok(Output::new(json!({ "bin_dir": paths.bin_dir }), text))
        }
        Command::Env { shell } => {
            let value = env_output(shell, &paths);
            let text = match (&value["shell"], shell) {
                (_, Shell::Json) => {
                    serde_json::to_string_pretty(&value["PATH"]).unwrap_or_default()
                }
                (s, _) => s.as_str().unwrap_or_default().to_owned(),
            };
            Ok(Output::new(value, text))
        }
        Command::Doctor => {
            let report = doctor(&paths)?;
            Ok(format_doctor(&report))
        }
    }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

fn format_refresh(result: &RefreshSummary) -> Output {
    let text = format!(
        "Registry refreshed\n  Source:      {}\n  Packages:    {}\n  Cache:       {}\n  Checksum:    {}",
        result.source,
        result.package_count,
        result.cache_file.display(),
        result.checksum
    );
    Output::new(result, text)
}

fn format_package_list(list: &[PackageSummary]) -> Output {
    if list.is_empty() {
        return Output::new(list, "No packages found.".to_owned());
    }
    let mut text = String::new();
    for pkg in list {
        let status = if pkg.deprecated {
            "deprecated"
        } else if pkg.installed {
            if pkg.outdated {
                "outdated"
            } else {
                "installed"
            }
        } else {
            "available"
        };
        let _ = writeln!(
            text,
            " {:<8}  {} {}  {}  {}",
            status,
            pkg.name,
            pkg.version.as_deref().unwrap_or("-"),
            pkg.categories.join(","),
            pkg.languages.join(",")
        );
    }
    // Trim trailing newline
    let text = text.trim_end().to_owned();
    Output::new(list, text)
}
fn format_suggestion_list(list: &[SuggestionItem]) -> Output {
    if list.is_empty() {
        return Output::new(list, "No suggested packages found.".to_owned());
    }
    let mut text = String::new();
    for item in list {
        let pkg = &item.package;
        let status = if pkg.installed {
            if pkg.outdated {
                "outdated"
            } else {
                "installed"
            }
        } else {
            "suggested"
        };
        let _ = writeln!(
            text,
            " {:<9}  {} {}  {}",
            status,
            pkg.name,
            pkg.version.as_deref().unwrap_or("-"),
            item.reason
        );
    }
    let text = text.trim_end().to_owned();
    Output::new(list, text)
}

fn format_installed_list(list: &[InstalledPackage]) -> Output {
    if list.is_empty() {
        return Output::new(list, "No packages installed.".to_owned());
    }
    let mut text = String::new();
    for pkg in list {
        let bins: Vec<&str> = pkg.bins.keys().map(String::as_str).collect();
        let _ = writeln!(
            text,
            " {} {}  bins: {}",
            pkg.name,
            pkg.version,
            bins.join(", ")
        );
    }
    let text = text.trim_end().to_owned();
    Output::new(list, text)
}

fn format_install_results(results: &[mason4agents::installer::InstallResult]) -> Output {
    if results.is_empty() {
        return Output::new(results, "Nothing to install.".to_owned());
    }
    let mut text = String::new();
    for result in results {
        let bins: Vec<&str> = result.bins.keys().map(String::as_str).collect();
        let _ = writeln!(
            text,
            " ✓ {} {}  bins: {}",
            result.package,
            result.version,
            bins.join(", ")
        );
    }
    let text = text.trim_end().to_owned();
    Output::new(results, text)
}

fn format_uninstall_results(results: &[mason4agents::installer::UninstallResult]) -> Output {
    if results.is_empty() {
        return Output::new(results, "Nothing to uninstall.".to_owned());
    }
    let mut text = String::new();
    for result in results {
        if result.removed {
            let _ = writeln!(text, " ✓ {} removed", result.package);
        } else {
            let _ = writeln!(text, " - {} not installed", result.package);
        }
    }
    let text = text.trim_end().to_owned();
    Output::new(results, text)
}

fn format_which(result: &mason4agents::installer::WhichResult, executable: &str) -> Output {
    let text = match &result.path {
        Some(p) => format!("{}", p.display()),
        None => format!("{} not found (not installed)", executable),
    };
    Output::new(result, text)
}

fn format_doctor(report: &mason4agents::doctor::DoctorReport) -> Output {
    let mut text = String::new();
    let _ = writeln!(text, "mason4agents doctor");
    let _ = writeln!(text, "  Bin dir:         {}", report.paths.bin_dir);
    let _ = writeln!(
        text,
        "  Bin dir exists:  {}",
        check(report.paths.bin_dir_exists)
    );
    let _ = writeln!(
        text,
        "  Data writable:   {}",
        check(report.paths.data_dir_writable)
    );
    let _ = writeln!(
        text,
        "  Registry cache:  {}",
        if report.registry.cache_present {
            format!("{} packages", report.registry.package_count)
        } else {
            report
                .registry
                .error
                .as_deref()
                .unwrap_or("missing")
                .to_owned()
        }
    );
    let _ = writeln!(
        text,
        "  PATH contains:   {}",
        check(report.path_env.contains_bin_dir)
    );
    let _ = writeln!(
        text,
        "  PATH is first:   {}",
        check(report.path_env.bin_dir_first)
    );
    let _ = writeln!(text, "  Managers:");
    for m in &report.managers {
        let _ = writeln!(
            text,
            "    {:<12}  {}",
            m.source_type,
            if m.available {
                "✓ installed"
            } else {
                "✗ missing"
            }
        );
    }
    let _ = writeln!(
        text,
        "  Overall:         {}",
        if report.ok {
            "✓ ok"
        } else {
            "✗ issues found"
        }
    );
    let text = text.trim_end().to_owned();
    Output::new(report, text)
}

fn check(b: bool) -> &'static str {
    if b {
        "✓"
    } else {
        "✗"
    }
}

fn env_output(shell: Shell, paths: &MasonPaths) -> serde_json::Value {
    let bin = paths.bin_dir.display().to_string();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let current_path = std::env::var("PATH").unwrap_or_default();
    let filtered_path = current_path
        .split(sep)
        .filter(|part| !part.is_empty() && *part != bin)
        .collect::<Vec<_>>()
        .join(&sep.to_string());
    let json_path = if filtered_path.is_empty() {
        bin.clone()
    } else {
        format!("{bin}{sep}{filtered_path}")
    };
    match shell {
        Shell::Bash | Shell::Zsh => {
            let quoted = bin.replace('\'', "'\\''");
            json!({ "shell": format!("export PATH='{}':\"$PATH\"", quoted) })
        }
        Shell::Fish => {
            let quoted = bin.replace('\'', "'\\''");
            json!({ "shell": format!("set -gx PATH '{}' $PATH", quoted) })
        }
        Shell::Powershell => {
            let quoted = bin.replace('"', "`\"");
            json!({ "shell": format!("$env:PATH = \"{}{}\" + $env:PATH", quoted, sep) })
        }
        Shell::Cmd => json!({ "shell": format!("set PATH={};%PATH%", bin) }),
        Shell::Json => json!({ "PATH": json_path }),
    }
}
