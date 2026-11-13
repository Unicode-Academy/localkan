//! Wire types shared with the server. Mirrors `packages/protocol/src/index.ts`; keep in sync.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A request from the server.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub kind: String,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<anyhow::Error> for BridgeError {
    fn from(e: anyhow::Error) -> Self {
        BridgeError::new("bridge_error", format!("{e:#}"))
    }
}

/// A message to the server.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Outgoing {
    Res {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<BridgeError>,
    },
    Event { event: String, data: Value },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitingInfo {
    /// "question" or "prompt"
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<Vec<String>>,
    /// Shared-browser tab that needs a sign-in (kind = "login").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    /// Page the agent was trying to open (kind = "login").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Partial card update. `Some(None)` serializes as `null` (clear the field);
/// `None` leaves the field untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardStatePatch {
    pub card_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<Option<WaitingInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Option<crate::preview::PreviewInfo>>,
}

impl CardStatePatch {
    pub fn new(card_id: &str) -> Self {
        Self { card_id: card_id.to_string(), ..Default::default() }
    }

    /// Fold `other` into `self` (fields present in `other` win).
    pub fn merge(&mut self, other: &CardStatePatch) {
        macro_rules! take {
            ($f:ident) => {
                if other.$f.is_some() {
                    self.$f = other.$f.clone();
                }
            };
        }
        take!(run_state);
        take!(status);
        take!(branch);
        take!(worktree_path);
        take!(dispatch_id);
        take!(waiting);
        take!(summary);
        take!(error);
        take!(preview);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub seq: i64,
    pub ts: String,
    pub source: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffFile {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub base_ref: String,
    pub files: Vec<DiffFile>,
    pub patch: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct OrcaInfo {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub device_name: String,
    pub version: String,
    pub orca: OrcaInfo,
    pub agents: BTreeMap<String, bool>,
}

// -- request params ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegister {
    pub project_id: String,
    pub repo_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardStart {
    pub card_id: String,
    pub project_id: String,
    pub repo_path: String,
    pub title: String,
    pub prompt: String,
    pub agent: String,
    pub mode: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default)]
    pub parent: Option<ParentRef>,
}

/// The card a new card continues from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentRef {
    pub card_id: String,
    pub title: String,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub project_id: String,
    pub repo_path: String,
    #[serde(default)]
    pub content: Option<String>,
}

/// An image attached to a card; downloaded from the server when the card starts.
#[derive(Debug, Clone, Deserialize)]
pub struct AttachmentRef {
    pub id: String,
    pub name: String,
    pub mime: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsPick {
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub start_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FsInspect {
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    pub is_git_repo: bool,
    pub is_empty: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardReply {
    pub card_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFollowup {
    pub card_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRef {
    pub card_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardLog {
    pub card_id: String,
    #[serde(default)]
    pub after: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFinish {
    pub card_id: String,
    pub action: String,
    pub commit_message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPreview {
    pub card_id: String,
    #[serde(default)]
    pub tunnel: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardScreenshot {
    pub card_id: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreview {
    pub project_id: String,
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub tunnel: bool,
    #[serde(default)]
    pub path: Option<String>,
}

/// `browser.action`: remote control of the shared browser (Orca's built-in browser).
/// Not Debug: `type` and `login` carry secrets that must never reach a log.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReq {
    pub project_id: String,
    #[serde(default)]
    pub repo_path: String,
    pub action: BrowserAction,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BrowserAction {
    Tabs,
    Open { url: String },
    Shot { page_id: String },
    Goto { page_id: String, url: String },
    Tap { page_id: String, x: f64, y: f64 },
    Type { page_id: String, text: String },
    Key { page_id: String, key: String },
    Scroll { page_id: String, dy: f64 },
    Back { page_id: String },
    Reload { page_id: String },
    Close { page_id: String },
    Login {
        page_id: String,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        otp: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub page_id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub worktree_path: Option<String>,
    pub card_id: Option<String>,
    pub main: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShot {
    pub page_id: String,
    pub data_url: String,
    pub width: f64,
    pub height: f64,
    pub url: String,
    pub title: String,
}
