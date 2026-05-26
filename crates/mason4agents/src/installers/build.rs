use crate::progress::{emit_error, NoProgressSink, ProgressSink, ProgressStatus};
use crate::types::{M4aError, Result};
use std::path::Path;
use std::process::Command;

pub fn run_build_scripts(scripts: &[String], cwd: &Path) -> Result<()> {
    let progress = NoProgressSink;
    run_build_scripts_with_progress(scripts, cwd, "install", None, &progress)
}

pub fn run_build_scripts_with_progress(
    scripts: &[String],
    cwd: &Path,
    operation: &str,
    package: Option<&str>,
    progress: &dyn ProgressSink,
) -> Result<()> {
    let result = (|| -> Result<()> {
        for script in scripts {
            progress.event(
                operation,
                "build",
                ProgressStatus::Started,
                package,
                "running build script",
            );
            let mut command = shell_command(script);
            let output = command.current_dir(cwd).output()?;
            if !output.status.success() {
                return Err(M4aError::CommandFailed {
                    program: script.clone(),
                    status: output.status.code().unwrap_or(-1),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                });
            }
            progress.event(
                operation,
                "build",
                ProgressStatus::Succeeded,
                package,
                "build script completed",
            );
        }
        Ok(())
    })();
    if let Err(err) = &result {
        emit_error(progress, operation, "build", package, err);
    }
    result
}

fn shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(script);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        cmd
    }
}
