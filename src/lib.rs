use std::{
    env,
    path::{Path, PathBuf},
};
use zed_extension_api as zed;

const EXTENSION_ID: &str = "rslint-lsp";
const SERVER_ID: &str = "rslint";
const LAUNCHER_PATH: &str = "dist/rslint-lsp.js";

struct RslintExtension;

impl zed::Extension for RslintExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!(
                "unknown language server: {}",
                language_server_id.as_ref()
            ));
        }

        let launcher = absolute_launcher_path()?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![launcher, "--workspace".to_string(), worktree.root_path()],
            env: worktree.shell_env(),
        })
    }
}

fn absolute_launcher_path() -> zed::Result<String> {
    let extension_dir = env::current_dir()
        .map_err(|error| format!("failed to locate the Rslint extension directory: {error}"))?;
    let work_launcher = extension_dir.join(LAUNCHER_PATH);
    if work_launcher.is_file() {
        return Ok(normalize_path(work_launcher));
    }

    if let Some(extensions_dir) = extension_dir.parent().and_then(Path::parent) {
        return Ok(normalize_path(
            extensions_dir
                .join("installed")
                .join(EXTENSION_ID)
                .join(LAUNCHER_PATH),
        ));
    }

    Err(format!(
        "Rslint launcher is missing at {}. Run `pnpm build` in the extension repository and reinstall the dev extension.",
        work_launcher.display()
    ))
}

fn normalize_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

zed::register_extension!(RslintExtension);
