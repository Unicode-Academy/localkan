//! Board skills: `.localkan/skills/<name>/SKILL.md` in the project folder (never committed),
//! linked into every task folder so every agent finds them: Claude Code reads `.claude/skills/`,
//! agy and Codex read `.agents/skills/`, Grok reads both. A repo's own skills in one of those folders are linked into the
//! other too, so each agent sees all of them. The links are kept out of git.

use crate::git;
use serde::Serialize;
use std::path::{Path, PathBuf};

const AGENT_DIRS: [&str; 2] = [".claude/skills", ".agents/skills"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

pub fn board_dir(project: &str) -> PathBuf {
    Path::new(project).join(".localkan").join("skills")
}

/// Skill folders (those with a SKILL.md) directly inside `dir`, sorted by name.
pub fn skills_in(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("SKILL.md").is_file())
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                .filter(|(n, _)| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The board's skills with their descriptions (for the web app).
pub fn list(project: &str) -> Vec<SkillInfo> {
    skills_in(&board_dir(project))
        .into_iter()
        .map(|(name, dir)| SkillInfo { description: description(&dir.join("SKILL.md")), name })
        .collect()
}

/// `description:` from the SKILL.md frontmatter.
fn description(file: &Path) -> String {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for l in lines {
        let t = l.trim();
        if t == "---" {
            break;
        }
        if let Some(v) = t.strip_prefix("description:") {
            return v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        }
    }
    String::new()
}

fn same(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// Link `src` as `<task>/<agent dir>/<name>` for both agents. Anything already there (the
/// repo's own skill, or an earlier link) is left alone. Returns whether a link was made.
fn link(task: &Path, name: &str, src: &Path, excludes: &mut Vec<String>) -> bool {
    let mut linked = false;
    for agent_dir in AGENT_DIRS {
        let dir = task.join(agent_dir);
        let dest = dir.join(name);
        if std::fs::symlink_metadata(&dest).is_ok() || same(&dest, src) {
            continue;
        }
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        if std::os::unix::fs::symlink(src, &dest).is_ok() {
            linked = true;
            excludes.push(format!("/{agent_dir}/{name}"));
        }
    }
    linked
}

/// A single-repo task (a git worktree of `repo`): board skills, plus the repo's own skills
/// made visible to both agents. Returns the names of the board skills that were linked.
pub async fn prepare_single(repo: &str, wt: &str) -> Vec<String> {
    let task = Path::new(wt);
    let mut names = Vec::new();
    let mut excludes = Vec::new();
    for (name, src) in skills_in(&board_dir(repo)) {
        if link(task, &name, &src, &mut excludes) || task.join(AGENT_DIRS[0]).join(&name).exists() {
            names.push(name);
        }
    }
    for agent_dir in AGENT_DIRS {
        for (name, src) in skills_in(&task.join(agent_dir)) {
            link(task, &name, &src, &mut excludes);
        }
    }
    // Links are untracked files of the worktree: keep them out of status, diffs and commits.
    for pattern in excludes {
        let _ = git::exclude_locally(wt, &pattern).await;
    }
    names
}

/// A multi-repo task folder (git ignores everything in it): board skills from the parent
/// folder, and every repo's own skills, at the top so agents have them from the start.
/// Returns what was linked, e.g. `["review", "frontend/ui-kit"]`.
pub fn prepare_multi(parent: &str, root: &str, children: &[(String, String)]) -> Vec<String> {
    let task = Path::new(root);
    let mut names = Vec::new();
    let mut ignored = Vec::new();
    for (name, src) in skills_in(&board_dir(parent)) {
        if link(task, &name, &src, &mut ignored) {
            names.push(name);
        }
    }
    for (child, wt) in children {
        for agent_dir in AGENT_DIRS {
            for (name, src) in skills_in(&Path::new(wt).join(agent_dir)) {
                let taken = AGENT_DIRS.iter().any(|d| std::fs::symlink_metadata(task.join(d).join(&name)).is_ok());
                let already = AGENT_DIRS.iter().any(|d| same(&task.join(d).join(&name), &src));
                if already {
                    continue;
                }
                let target = if taken { format!("{child}-{name}") } else { name.clone() };
                if link(task, &target, &src, &mut ignored) {
                    names.push(format!("{child}/{name}"));
                }
            }
        }
    }
    names
}

/// A line for the task text so agents know these skills exist.
pub fn note(names: &[String]) -> String {
    if names.is_empty() {
        return String::new();
    }
    format!(
        "\n\nSkills prepared for this task (in .claude/skills/ and .agents/skills/): {}. Use them when they fit.",
        names.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(dir: &Path, name: &str, desc: &str) {
        std::fs::create_dir_all(dir.join(name)).unwrap();
        std::fs::write(dir.join(name).join("SKILL.md"), format!("---\nname: {name}\ndescription: \"{desc}\"\n---\nBody\n")).unwrap();
    }

    #[test]
    fn links_board_and_repo_skills_for_both_agents() {
        let tmp = std::env::temp_dir().join(format!("lk-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let parent = tmp.join("shop");
        let root = tmp.join("task");
        skill(&board_dir(parent.to_str().unwrap()), "review", "Review checklist");
        skill(&root.join("frontend/.claude/skills"), "ui-kit", "UI components");
        skill(&root.join("backend/.agents/skills"), "review", "Backend review");
        std::fs::create_dir_all(&root).unwrap();

        assert_eq!(list(parent.to_str().unwrap())[0].description, "Review checklist");
        let names = prepare_multi(
            parent.to_str().unwrap(),
            root.to_str().unwrap(),
            &[
                ("backend".into(), root.join("backend").to_string_lossy().into()),
                ("frontend".into(), root.join("frontend").to_string_lossy().into()),
            ],
        );
        assert_eq!(names, vec!["review", "backend/review", "frontend/ui-kit"]);
        for d in AGENT_DIRS {
            assert!(root.join(d).join("review/SKILL.md").is_file());
            assert!(root.join(d).join("backend-review/SKILL.md").is_file());
            assert!(root.join(d).join("ui-kit/SKILL.md").is_file());
        }
        // Running again (a retry) changes nothing.
        assert!(prepare_multi(parent.to_str().unwrap(), root.to_str().unwrap(), &[]).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
