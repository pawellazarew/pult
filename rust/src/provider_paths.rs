//! Fixed installation candidates shared by diagnostic and execution lookup.
//! Pure paths only: no shell, process, account or configuration access.
use std::path::{Path, PathBuf};

pub fn candidates(user: &Path, name: &str) -> Vec<PathBuf> {
    let local = |s: &str| user.join(s);
    let system = |s: &str| PathBuf::from(s);
    match name {
        "claude" => vec![
            system("/opt/homebrew/bin/claude"),
            local(".claude/local/claude"),
            system("/usr/local/bin/claude"),
            local(".local/bin/claude"),
        ],
        "codex" => vec![
            local(".local/bin/codex"),
            system("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"),
            system("/Applications/ChatGPT.app/Contents/Resources/codex"),
            system("/opt/homebrew/bin/codex"),
            system("/usr/local/bin/codex"),
        ],
        "opencode" => vec![
            system("/opt/homebrew/bin/opencode"),
            local(".local/bin/opencode"),
            local(".opencode/bin/opencode"),
            system("/usr/local/bin/opencode"),
        ],
        "zcode" => vec![
            local(".local/bin/zcode"),
            system("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
            local("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
            system("/opt/homebrew/bin/zcode"),
            system("/usr/local/bin/zcode"),
        ],
        "git" => vec![
            system("/opt/homebrew/bin/git"),
            system("/usr/bin/git"),
            system("/usr/local/bin/git"),
        ],
        "gh" => vec![
            system("/opt/homebrew/bin/gh"),
            system("/usr/local/bin/gh"),
            local(".local/bin/gh"),
        ],
        _ => vec![
            system(&format!("/opt/homebrew/bin/{name}")),
            system(&format!("/usr/local/bin/{name}")),
            system(&format!("/usr/bin/{name}")),
        ],
    }
}
