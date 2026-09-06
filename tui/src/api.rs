//! The local API, as seen from Rust.
//!
//! The server already does all of this work — `GET /api/state` returns the whole
//! scanned world and `GET /api/events` pushes when the files under it change. So
//! this crate reimplements nothing: it is a second front end to the API the web
//! app was already using, and `packages/data/src/client.ts` is its sibling.
//!
//! Every refusal the server can produce is interesting and specific — a dirty
//! working tree names the files, a read-only target names itself, a missing patch
//! says so. `Client` surfaces the server's own `{ error }` message rather than
//! replacing it with a generic one.

use serde::Deserialize;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "http://127.0.0.1:7777";

/* ------------------------------------------------------------ wire shapes ---- */

/// Mirrors `packages/data/src/types.ts`. Unknown fields are ignored and missing
/// ones default, so the server can grow a field without breaking the TUI.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Suggestion {
    pub id: String,
    /// Three letters of the name, handed out by core to be unique across the
    /// corpus — the handle a card wears, so it can be named in a sentence and
    /// found again after it changes lanes.
    pub uid: String,
    pub target: String,
    pub skill: String,
    pub date: String,
    /// `today` / `this week` / `this month` / `older`, stamped by core as of the
    /// state's build — the board rules a line where it changes.
    pub age: String,
    /// The same four words, but measured from when a finished card *finished*
    /// rather than when it was filed. Equal to `age` for an open card. What the
    /// closed lane hides history by, so a July finding verified this morning
    /// reads as today's news.
    #[serde(rename = "closedAge")]
    pub closed_age: String,
    pub slug: String,
    pub severity: String,
    pub status: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub objective: String,
    pub scope: String,
    pub rung: Option<i64>,
    pub effort: String,
    /// Why this sits where it sits, when a pass parked it on a decision only
    /// the user can make. Empty otherwise.
    #[serde(rename = "blockedOn")]
    pub blocked_on: String,
    /// The open suggestion the block names, when it names one. Empty when the
    /// block is on you — which is the whole difference between a card that
    /// parks out of the way and one that stands in its lane with the flag up.
    #[serde(rename = "blockedBy")]
    pub blocked_by: String,
    /// Who has to check the status before the card is where it says — the
    /// runner's flag, cleared by the reviewer. Empty once settled.
    #[serde(rename = "needsReview")]
    pub needs_review: String,
    #[serde(rename = "appliedSha")]
    pub applied_sha: String,
    /// When the problem was last confirmed to still exist, and at which commit.
    /// A confirmation is worth exactly as much as the commit it names.
    #[serde(rename = "confirmedAt")]
    pub confirmed_at: String,
    pub recurrences: u64,
    pub incidents: u64,
    pub context: String,
    pub suggestion: String,
    pub rationale: String,
    /// What opencode found on the landed change, and what claude decided on
    /// each check — the reason behind a block, readable without the file.
    pub review: String,
    pub verdict: String,
    /// What you said the last time this card was parked on you.
    pub answer: String,
    pub missing: Vec<String>,
    pub triaged: bool,
    pub surfaced: bool,
    pub score: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Metrics {
    pub total: u64,
    pub open: u64,
    pub untriaged: u64,
    pub incidents: u64,
    /// Open cards parked on a decision only you can make.
    #[serde(rename = "onYou")]
    pub on_you: u64,
}

/// A skill as the scanner sees it. `health` is computed by `buildState` rather
/// than here — the scanner is the single source for everything else on the row,
/// and re-deriving one field in Rust is how the two drift.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Skill {
    pub name: String,
    pub kind: String,
    pub target: String,
    pub path: String,
    pub project: String,
    pub lines: u64,
    pub scripts: u64,
    pub suggestions: u64,
    pub per100: f64,
    pub health: String,
    pub worktrees: u64,
}

/// How a landing refused. `Parked` means the server wrote the reason on the
/// card — the patch itself cannot land — and a lane walk should keep going;
/// `Stopped` means the tree is not ready, which is the reason the rest of the
/// lane would refuse too.
#[derive(Debug, Clone, PartialEq)]
pub enum ApplyRefusal {
    Parked(String),
    Stopped(String),
}

impl std::fmt::Display for ApplyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyRefusal::Parked(why) | ApplyRefusal::Stopped(why) => f.write_str(why),
        }
    }
}

/// One run, as the server reports it — still going, or how it ended.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Run {
    pub pid: u64,
    /// The suggestion the run is fenced to; `None` means the whole backlog.
    pub id: Option<String>,
    /// Who has the seat — `opencode` or `claude`. Empty for a run adopted
    /// across a restart from a record that predates the field.
    pub runner: String,
    pub running: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i64>,
    /// Epoch milliseconds — one subtraction away from "up 3m".
    #[serde(rename = "startedAt")]
    pub started_at: Option<u64>,
}

/// The agents: every run this server has seen (live ones and the last few
/// that ended), and who waits for a seat, in order — `None` is the backlog.
/// A card's index in `queue` plus one is the number the board draws on it.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Dispatch {
    pub runs: Vec<Run>,
    pub queue: Vec<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct State {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub warnings: Vec<String>,
    pub skills: Vec<Skill>,
    pub suggestions: Vec<Suggestion>,
    pub metrics: Metrics,
    pub dispatch: Option<Dispatch>,
}

/* ------------------------------------------------------------------ config ---- */

/// Only what the settings view draws. Unknown keys are ignored on the way in and
/// preserved on the way out, because editing round-trips the raw JSON — the TUI
/// never rewrites a config from this struct.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub targets: Vec<Target>,
    pub scan: ScanConfig,
    pub surface: SurfaceConfig,
    pub cadence: Cadence,
    #[serde(rename = "applyGuards")]
    pub apply_guards: Guards,
    pub server: ServerConfig,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Target {
    pub name: String,
    pub skills: String,
    pub feedback: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct ScanConfig {
    pub enabled: bool,
    pub roots: Vec<String>,
    pub depth: u64,
    pub writable: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct SurfaceConfig {
    pub types: Vec<String>,
    pub objectives: Vec<String>,
    #[serde(rename = "minSeverity")]
    pub min_severity: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Cadence {
    pub weekly: String,
    #[serde(rename = "sessionHook")]
    pub session_hook: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Guards {
    #[serde(rename = "requireCleanTree")]
    pub require_clean_tree: bool,
    #[serde(rename = "requireDiffApplies")]
    pub require_diff_applies: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u64,
}

/* ------------------------------------------------------------------ stream ---- */

/// Subscribe to `/api/events` on a background thread; each named `event:` line is
/// sent over `tx`. Reconnects forever with a small backoff, and reports a drop as
/// `__disconnected` so the header can stop claiming to be live.
pub fn spawn_stream(base: String, tx: std::sync::mpsc::Sender<String>) {
    use std::io::BufRead;
    std::thread::spawn(move || loop {
        // A plain request, not the timeout-bearing agent: the stream must live
        // forever, and a read timeout would tear it down every 30 seconds.
        if let Ok(res) = ureq::get(&format!("{base}/api/events")).call() {
            let reader = std::io::BufReader::new(res.into_reader());
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(event) = line.strip_prefix("event: ") {
                    if tx.send(event.trim().to_string()).is_err() {
                        return;
                    }
                }
            }
        }
        if tx.send("__disconnected".into()).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

/* ------------------------------------------------------------ server start ---- */

/// Is anything answering on the port? A short timeout on purpose — this runs
/// before the terminal is taken over, and a dead port should be obvious fast.
pub fn server_is_up(base: &str) -> bool {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .build()
        .get(&format!("{base}/api/health"))
        .call()
        .is_ok()
}

pub enum Started {
    AlreadyUp,
    Spawned,
}

/// `scripts/cli.mjs`, found by walking up from the binary.
///
/// `current_exe` reads `/proc/self/exe`, so this still resolves through the
/// `~/.local/bin` symlink to the real path inside the repo. Walking up rather
/// than counting components keeps it working for both `target/release` and
/// `target/debug`.
fn find_cli() -> Option<std::path::PathBuf> {
    if let Some(explicit) = std::env::var_os("KAIZEN_CLI") {
        let path = std::path::PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..6 {
        let candidate = dir.join("scripts").join("cli.mjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
    None
}

/// Start `kaizen serve` if nothing is listening, and wait for it to bind.
///
/// The server is the engine — @kaizen/core does the scanning, grouping and
/// scoring, and this crate is a client of it — so the TUI is useless without one.
/// Starting it here rather than making you remember is the whole point.
///
/// The child gets its own process group: without that, the Ctrl-C that quits the
/// TUI goes to the whole foreground group and takes the server down with it.
pub fn ensure_server(base: &str) -> Result<Started, String> {
    if server_is_up(base) {
        return Ok(Started::AlreadyUp);
    }
    let cli = find_cli().ok_or_else(|| {
        "cannot find scripts/cli.mjs to start the server — set KAIZEN_CLI to its path".to_string()
    })?;

    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new("node");
    command
        .arg(&cli)
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    command.process_group(0);

    command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "node is not on PATH, so the server cannot be started".into(),
        _ => format!("could not start the server: {e}"),
    })?;

    // Binding is fast; scanning the skills tree on the first request is not, so
    // wait for the port rather than for a state response.
    for _ in 0..40 {
        if server_is_up(base) {
            return Ok(Started::Spawned);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("started the server but nothing answered at {base}"))
}

/* ------------------------------------------------------------------ client ---- */

pub struct Client {
    base: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: Option<String>) -> Self {
        let base = base
            .or_else(|| std::env::var("KAIZEN_API").ok())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        Self {
            agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build(),
            base,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// The server's own message, when it sent one. `git apply` failures and dirty
    /// trees arrive here as prose worth reading verbatim.
    fn explain(&self, err: ureq::Error, what: &str) -> String {
        match err {
            ureq::Error::Status(code, res) => res
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| format!("{what} -> {code}")),
            ureq::Error::Transport(_) => {
                format!("cannot reach the kaizen server at {} — is it running?", self.base)
            }
        }
    }

    pub fn state(&self) -> Result<State, String> {
        let url = format!("{}/api/state", self.base);
        self.agent
            .get(&url)
            .call()
            .map_err(|e| self.explain(e, "GET /api/state"))?
            .into_json::<State>()
            .map_err(|e| format!("GET /api/state: bad JSON: {e}"))
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        self.post_raw(path, body).map_err(|(msg, _)| msg)
    }

    /// `post`, keeping the refusal's body beside its sentence: one route says
    /// more than `error` when it refuses — `apply` says whether it parked the
    /// card — and the sentence alone cannot carry that.
    fn post_raw(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, (String, Option<serde_json::Value>)> {
        let url = format!("{}{}", self.base, path);
        match self.agent.post(&url).send_json(body) {
            Ok(res) => res
                .into_json::<serde_json::Value>()
                .map_err(|e| (format!("POST {path}: bad JSON: {e}"), None)),
            Err(ureq::Error::Status(code, res)) => {
                let body = res.into_json::<serde_json::Value>().ok();
                let msg = body
                    .as_ref()
                    .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| format!("POST {path} -> {code}"));
                Err((msg, body))
            }
            Err(e) => Err((self.explain(e, &format!("POST {path}")), None)),
        }
    }

    pub fn set_status(&self, id: &str, status: &str) -> Result<(), String> {
        self.post("/api/suggestion", serde_json::json!({ "id": id, "status": status })).map(|_| ())
    }

    /// Write what a card waits on, or clear it with an empty string. Its own
    /// call rather than a flavour of `set_status`: nothing moves, and the
    /// server tells the two apart by whether the key is there at all.
    pub fn set_block(&self, id: &str, text: &str) -> Result<(), String> {
        self.post("/api/suggestion", serde_json::json!({ "id": id, "blockedOn": text }))
            .map(|_| ())
    }

    /// Approving everything approvable is one decision, so it is one request.
    /// The server moves what can legally move and skips an unready candidate;
    /// the pair is (moved, skipped), and both belong in the message.
    pub fn sweep(&self, status: &str) -> Result<(u64, u64), String> {
        let res = self.post("/api/sweep", serde_json::json!({ "status": status }))?;
        Ok((
            res.get("moved").and_then(|v| v.as_u64()).unwrap_or(0),
            res.get("skipped").and_then(|v| v.as_u64()).unwrap_or(0),
        ))
    }

    /// Hand work to one detached claude run — one suggestion when fenced to an
    /// id, the backlog otherwise. Returns how many items the pass covers;
    /// progress comes back through the event stream as the run writes, so
    /// there is nothing to poll.
    /// Returns how many items the pass can move and, when the seat was taken,
    /// the place in line it was given — zero means it started now.
    pub fn dispatch(&self, id: Option<&str>) -> Result<(u64, u64), String> {
        let body = match id {
            Some(id) => serde_json::json!({ "id": id }),
            None => serde_json::json!({}),
        };
        let res = self.post("/api/dispatch", body)?;
        let n = |k: &str| res.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        Ok((n("pending"), n("queued")))
    }

    /// Returns the commit sha and how many carried siblings the landing
    /// closed. Can refuse two ways: a patch that cannot land, which the server
    /// answers by parking the card with the reason (`Err(Parked)`), and a tree
    /// that is not ready, which is transient and stops a lane walk.
    pub fn apply(&self, id: &str) -> Result<(String, u64), ApplyRefusal> {
        let res = self
            .post_raw("/api/apply", serde_json::json!({ "id": id }))
            .map_err(|(msg, body)| {
                let parked = body.and_then(|b| b.get("parked").and_then(|v| v.as_bool())).unwrap_or(false);
                if parked { ApplyRefusal::Parked(msg) } else { ApplyRefusal::Stopped(msg) }
            })?;
        Ok((
            res.get("sha").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            res.get("closed").and_then(|v| v.as_u64()).unwrap_or(0),
        ))
    }

    /// One of the ways out of a parked card, chosen from the board's menu. The
    /// server composes the writes; this only names the choice and carries what
    /// the choice asked for — a line of text, or a target.
    pub fn unblock(
        &self,
        id: &str,
        choice: &str,
        text: Option<&str>,
        target: Option<&str>,
    ) -> Result<String, String> {
        let mut body = serde_json::json!({ "id": id, "choice": choice });
        if let Some(t) = text {
            body["text"] = serde_json::Value::String(t.to_string());
        }
        if let Some(t) = target {
            body["target"] = serde_json::Value::String(t.to_string());
        }
        let res = self.post("/api/unblock", body)?;
        Ok(res.get("did").and_then(|v| v.as_str()).unwrap_or("done").to_string())
    }

    /// The live config, as both a typed view and the raw JSON.
    ///
    /// Both, because they answer different questions: the struct is what the
    /// settings view draws, and the raw value is what an edit round-trips. Going
    /// back out through the struct would silently drop any key it does not know.
    pub fn config(&self) -> Result<(Config, serde_json::Value), String> {
        let url = format!("{}/api/config", self.base);
        let body: serde_json::Value = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| self.explain(e, "GET /api/config"))?
            .into_json()
            .map_err(|e| format!("GET /api/config: bad JSON: {e}"))?;
        let raw = body.get("config").cloned().unwrap_or(serde_json::Value::Null);
        let typed: Config = serde_json::from_value(raw.clone())
            .map_err(|e| format!("GET /api/config: unexpected shape: {e}"))?;
        Ok((typed, raw))
    }

    /// Save a whole config. The server validates and refuses with its own list of
    /// reasons, which is the message worth showing.
    pub fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        self.post("/api/config", config.clone()).map(|_| ())
    }

    /// A skill's source, for reading in the pane. The server refuses anything
    /// outside a configured target, so a bad path is a 403 rather than a leak.
    pub fn skill_file(&self, path: &str) -> Result<String, String> {
        let url = format!("{}/api/skill?path={}", self.base, urlencode(path));
        let res = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| self.explain(e, "GET /api/skill"))?
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("GET /api/skill: bad JSON: {e}"))?;
        Ok(res.get("content").and_then(|v| v.as_str()).unwrap_or_default().to_string())
    }

    /// The tail of the triage log, via the API rather than the filesystem — the
    /// server knows where its log lives; the TUI deliberately does not.
    pub fn diff(&self, id: &str) -> Result<Option<String>, String> {
        let url = format!("{}/api/diff?id={}", self.base, urlencode(id));
        let res = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| self.explain(e, "GET /api/diff"))?
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("GET /api/diff: bad JSON: {e}"))?;
        Ok(res.get("patch").and_then(|v| v.as_str()).map(String::from))
    }
}

/// Suggestion ids are `<target>/<skill>/<file>.md`, so the slashes and dots have
/// to survive the query string. Small enough not to justify a dependency.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/* ------------------------------------------------------------------ tests ---- */

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a live `GET /api/state`, including a field the types file does
    /// not mention (`outcome`) — the server grows fields and the TUI must not care.
    const STATE: &str = r#"{
      "generatedAt": "2026-08-08T22:00:00.000Z",
      "warnings": [],
      "suggestions": [
        { "id": "user/kaizen/a.md", "skill": "kaizen", "severity": "medium",
          "status": "new", "type": "structural", "score": 10, "surfaced": true,
          "outcome": "partial", "incidents": 1, "rung": 1 },
        { "id": "user/kaizen/b.md", "skill": "kaizen", "severity": "high",
          "status": "approved", "type": "content", "score": 42, "surfaced": true },
        { "id": "user/kaizen/c.md", "skill": "kaizen", "status": "applied",
          "score": 99, "surfaced": true },
        { "id": "user/kaizen/d.md", "skill": "kaizen", "status": "new",
          "score": 99, "surfaced": false },
        { "id": "user/kaizen/e.md", "skill": "kaizen", "status": "verified",
          "score": 98, "surfaced": true },
        { "id": "user/kaizen/f.md", "skill": "kaizen", "status": "superseded",
          "score": 97, "surfaced": true }
      ],
      "metrics": { "total": 4, "open": 3, "untriaged": 0 }
    }"#;

    #[test]
    fn parses_a_real_state_including_unknown_fields() {
        let state: State = serde_json::from_str(STATE).expect("parses");
        assert_eq!(state.suggestions.len(), 6);
        assert_eq!(state.metrics.open, 3);
        assert_eq!(state.suggestions[0].rung, Some(1));
        assert_eq!(state.suggestions[0].kind, "structural");
    }

    #[test]
    fn missing_fields_default_rather_than_failing_the_parse() {
        let state: State = serde_json::from_str(r#"{"suggestions":[{"id":"x"}]}"#).unwrap();
        assert_eq!(state.suggestions[0].id, "x");
        assert_eq!(state.suggestions[0].severity, "");
        assert_eq!(state.suggestions[0].rung, None);
    }

    #[test]
    fn ids_survive_the_query_string() {
        assert_eq!(
            urlencode("user/kaizen/2026-08-08-a-b.md"),
            "user%2Fkaizen%2F2026-08-08-a-b.md"
        );
    }
}
