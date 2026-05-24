use crate::types::{M4aError, Result};
use std::path::Path;
use std::process::Command;

pub fn run_build_scripts(scripts: &[String], cwd: &Path) -> Result<()> {
    for script in scripts {
        let mut command = shell_command(script);
        let output = command.current_dir(cwd).output()?;
        if !output.status.success() {
            return Err(M4aError::CommandFailed {
                program: script.clone(),
                status: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
    }
    Ok(())
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
