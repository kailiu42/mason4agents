use crate::progress::{emit_error, NoProgressSink, ProgressSink, ProgressStatus};
use crate::types::{command_failure_summary, command_output_for_log, M4aError, Result};
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
            log_command_output(
                progress,
                package,
                cwd,
                script,
                output.status.code(),
                &output.stdout,
                &output.stderr,
            );
            if !output.status.success() {
                return Err(M4aError::CommandFailed {
                    program: script.clone(),
                    status: output.status.code().unwrap_or(-1),
                    summary: command_failure_summary(&output.stdout, &output.stderr),
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

fn log_command_output(
    progress: &dyn ProgressSink,
    package: Option<&str>,
    cwd: &Path,
    script: &str,
    status: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) {
    progress.log(&format!(
        "\n=== build script package={} cwd={} status={} ===\nscript:\n{}\n{}",
        package.unwrap_or("-"),
        cwd.display(),
        status
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        script,
        command_output_for_log(stdout, stderr)
    ));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_build_script_summarizes_error_and_writes_full_log() {
        let tmp = tempfile::tempdir().unwrap();
        let progress = crate::progress::OperationProgressSink::new(
            &NoProgressSink,
            tmp.path(),
            "install",
            "scripted",
        )
        .unwrap();
        #[cfg(windows)]
        let script = "echo stdout-line && echo stderr-line 1>&2 && exit /b 7";
        #[cfg(not(windows))]
        let script = "printf stdout-line; printf stderr-line >&2; exit 7";

        let err = run_build_scripts_with_progress(
            &[script.to_owned()],
            tmp.path(),
            "install",
            Some("scripted"),
            &progress,
        )
        .unwrap_err();

        let message = err.to_string();
        assert!(message.contains("stdout-line"));
        assert!(message.contains("exited with 7"));
        let log = std::fs::read_to_string(progress.log_path().unwrap()).unwrap();
        assert!(log.contains("stdout-line"));
        assert!(log.contains("stderr-line"));
        assert!(log.contains("scripted"));
    }
}
