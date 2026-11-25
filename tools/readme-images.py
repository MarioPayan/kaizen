#!/usr/bin/env python3
"""Generate the README images: docs/images/loop.svg and docs/images/suggestion.svg.

Nothing in either picture is typed from memory. The script builds a throwaway
skills tree, feedback folder and config in a temporary directory, runs the real
CLI against them (`capture --check`, `status`, `list`, `close`) and a real git
commit, and draws what came back. The suggestion file is written from the
capture template in skills/_lib/skill-reflect.md, and the script refuses to draw
if that template, the statuses in core, or the CLI's close fields have drifted
from what the pictures say.

Two layout rules, borrowed from AImeter: direct fill= attributes instead of a
<style> block, because GitHub serves README SVGs through an image proxy into an
<img>; and every run of text at an explicit x with its own textLength, so
columns line up whatever monospace font the viewer has.

Run: python3 tools/readme-images.py   (needs node and git; no other dependencies)
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMAGES = ROOT / "docs" / "images"
CLI = ROOT / "scripts" / "cli.mjs"

MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace"
BG, CHROME, EDGE, RULE, HAIR = "#17181c", "#1e2027", "#2a2c33", "#262931", "#3a3d46"
BODY, FAINT, PROMPT, HEAD, LABEL = "#c3c7cd", "#727783", "#7ba6cd", "#6c7280", "#9aa0aa"
OK, WARN, CRIT, KEY, ACCENT = "#5faf5f", "#d7af5f", "#d75f5f", "#87afaf", "#af87d7"

# ── the fictional run both pictures show ────────────────────────────────────
SKILL = "release-notes"
SCOPE = f"{SKILL}/SKILL.md"
SLUG = "changelog-path-moved"
DATE = "2026-11-20"
FILE = f"{DATE}-{SLUG}.md"
ID = f"user/{SKILL}/{FILE}"
SHOWN_FEEDBACK = "~/.claude/skills-feedback"
COMMIT_SUBJECT = "release-notes: read the changelog from docs/"

SUGGESTION_FIELDS = {
    "skill": SKILL,
    "date": DATE,
    "outcome": "partial",
    "severity": "medium",
    "scope": SCOPE,
    "status": "open",
}
SECTIONS = {
    "Context": "Drafting v2.4.0 notes, Read CHANGELOG.md failed: the file moved to docs/.",
    "Suggestion": "Read docs/CHANGELOG.md, and stop with its path if it is missing.",
    "Evidence": "Read(CHANGELOG.md): file not found; git log shows it moved to docs/.",
}

SKILL_BEFORE = "# release-notes\n\n1. Read `CHANGELOG.md` and draft the notes for the new tag.\n"
SKILL_AFTER = (
    "# release-notes\n\n1. Read `docs/CHANGELOG.md` and draft the notes for the new tag.\n"
    "   If it is missing, stop and name the path you looked for.\n"
)


# ── drift checks: the pictures describe these, so these must still be true ─
def contract():
    """Read the capture template and enumerations the suggestion picture labels."""
    text = (ROOT / "skills" / "_lib" / "skill-reflect.md").read_text()
    block = re.search(r"```markdown\n---\n(.*?)\n---\n(.*?)```", text, re.S)
    if not block:
        raise SystemExit("skill-reflect.md: capture template not found")
    keys = [line.split(":", 1)[0] for line in block.group(1).splitlines()]
    sections = re.findall(r"^## (\w+)", block.group(2), re.M)
    severity = re.search(r"^severity: (.*)$", block.group(1), re.M).group(1)
    outcomes = re.findall(r"`(\w+)`", re.search(r"`OUTCOME`: (.*)", text).group(1))
    path = re.search(r"`(<feedback>/<SKILL_NAME>/[^`]+)`", text).group(1)
    reflection = re.findall(r"`(Reflection: [^`]+)`", text)
    if keys != list(SUGGESTION_FIELDS) or sections != list(SECTIONS):
        raise SystemExit(f"template drift: {keys} {sections}")
    statuses = re.search(r"STATUSES = \[(.*?)\]", (ROOT / "packages/core/src/suggestion.mjs").read_text())
    statuses = re.findall(r"'(\w+)'", statuses.group(1))
    cli = CLI.read_text()
    for field in ("closed_at", "fixed_by", "dropped_reason", "'Resolution'"):
        if field not in cli:
            raise SystemExit(f"cli.mjs no longer writes {field}")
    if "Kaizen-Suggestion: <id>" not in (ROOT / "skills/kaizen/SKILL.md").read_text():
        raise SystemExit("kaizen SKILL.md no longer asks for the Kaizen-Suggestion trailer")
    return {
        "severity": [s.strip() for s in severity.split("|")],
        "outcomes": outcomes,
        "statuses": statuses,
        "path": path,
        "reflection": reflection,
    }


# ── the real run ─────────────────────────────────────────────────────────────
def run(cmd, env, cwd=None):
    done = subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True)
    if done.returncode not in (0,):
        raise SystemExit(f"{cmd} failed ({done.returncode}):\n{done.stdout}{done.stderr}")
    return done.stdout.rstrip("\n")


def suggestion_text():
    front = "\n".join(f"{k}: {v}" for k, v in SUGGESTION_FIELDS.items())
    body = "\n\n".join(f"## {name}\n\n{text}" for name, text in SECTIONS.items())
    return f"---\n{front}\n---\n\n{body}\n"


def real_run():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="kaizen-readme-"))
    skills, feedback = tmp / "skills", tmp / "feedback"
    (skills / SKILL).mkdir(parents=True)
    (feedback / SKILL).mkdir(parents=True)
    config = tmp / "config.json"
    config.write_text(json.dumps({
        "version": 1,
        "targets": [{"name": "user", "skills": str(skills), "feedback": str(feedback)}],
    }))
    stamp = f"{DATE}T09:00:00+00:00"
    env = {
        "PATH": os.environ["PATH"], "HOME": str(tmp), "KAIZEN_CONFIG": str(config),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Example", "GIT_AUTHOR_EMAIL": "dev@example.com",
        "GIT_COMMITTER_NAME": "Example", "GIT_COMMITTER_EMAIL": "dev@example.com",
        "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp,
    }
    node = lambda *a: run(["node", str(CLI), *a], env)  # noqa: E731
    git = lambda *a: run(["git", "-c", "commit.gpgsign=false", *a], env, skills)  # noqa: E731

    git("init", "-q", "-b", "main")
    (skills / SCOPE).write_text(SKILL_BEFORE)
    git("add", "-A")
    git("commit", "-q", "-m", "release-notes: first version")

    out = {"status_empty": node("status")}
    out["check"] = node("capture", "--check", "--skill", SKILL, "--scope", SCOPE, "--slug", SLUG)
    (feedback / SKILL / FILE).write_text(suggestion_text())
    out["status_one"] = node("status")
    out["list"] = node("list", "--by", "scope", "--text")
    (skills / SCOPE).write_text(SKILL_AFTER)
    git("commit", "-q", "-a", "-m", f"{COMMIT_SUBJECT}\n\nKaizen-Suggestion: {ID}")
    out["sha"] = git("rev-parse", "--short=7", "HEAD")
    out["stat"] = git("diff", "--numstat", "HEAD~1", "HEAD")
    out["close"] = node("close", ID, "--fixed", out["sha"])
    out["status_done"] = node("status")
    out["trailer"] = git("log", "-1", "--format=%(trailers:key=Kaizen-Suggestion)")
    out["file"] = suggestion_text()
    shutil.rmtree(tmp)
    return out


# ── drawing ──────────────────────────────────────────────────────────────────
class Svg:
    def __init__(self, w, h, size):
        self.w, self.h, self.size, self.adv = w, h, size, size * 0.6
        self.parts = []

    def raw(self, s):
        self.parts.append(s)

    def text(self, x, y, s, fill=BODY, size=None, anchor="start", exact=True):
        size = size or self.size
        right = x + len(s) * size * 0.6 if anchor == "start" else x
        if right > self.w - 12:
            raise SystemExit(f"text overflows the image ({right:.0f} > {self.w - 12}): {s!r}")
        length = f' textLength="{len(s) * size * 0.6:.1f}" lengthAdjust="spacing"' if exact else ""
        self.raw(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{MONO}" font-size="{size}"{length} '
            f'text-anchor="{anchor}" fill="{fill}" xml:space="preserve">{escape(s)}</text>'
        )

    def runs(self, x, y, parts, size=None):
        """Coloured pieces laid end to end on one line, each at its own column."""
        col = 0
        for s, fill in parts:
            if s.strip():
                self.text(x + col * (size or self.size) * 0.6, y, s, fill, size)
            col += len(s)

    def line(self, x1, y1, x2, y2, stroke=EDGE):
        self.raw(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}"/>')

    def frame(self, title):
        w, h = self.w, self.h
        self.parts[:0] = [
            f'<rect x="0" y="0" width="{w}" height="{h}" rx="8" fill="{BG}"/>',
            f'<path d="M0 8a8 8 0 0 1 8-8h{w - 16}a8 8 0 0 1 8 8v30H0z" fill="{CHROME}"/>',
            f'<line x1="0" y1="38" x2="{w}" y2="38" stroke="{EDGE}"/>',
        ]
        self.text(26, 25, title, FAINT, 12.5)
        self.raw(f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="8" fill="none" stroke="{EDGE}"/>')

    def write(self, name, label):
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
            f'viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(label)}">'
            + "".join(self.parts) + "</svg>\n"
        )
        (IMAGES / name).write_text(svg)
        print(f"wrote {IMAGES / name}  {self.w}x{self.h}")


def loop_svg(real, spec):
    """The hero: one capture, the reminder, the repair session, the count back at zero."""
    shown_path = f"{SHOWN_FEEDBACK}/{SKILL}/{FILE}"
    reflection = f"Reflection: {shown_path}"
    if "Reflection: <path>" not in spec["reflection"]:
        raise SystemExit("skill-reflect.md no longer prints `Reflection: <path>`")
    added, removed, _ = real["stat"].split("\t")
    if real["trailer"].strip() != f"Kaizen-Suggestion: {ID}":
        raise SystemExit(f"trailer drift: {real['trailer']!r}")
    list_lines = real["list"].splitlines()

    svg = Svg(1040, 0, 13)
    A = svg.adv
    X = 80                      # text column; the rail and step numbers sit left of it
    T = X + 2 * A               # tool output column
    blocks = []                 # (step number, caption, first y, last y)
    y = 76

    def step(n, caption):
        nonlocal y
        blocks.append([n, caption, y, y])
        svg.text(X, y, caption, HEAD, 11.5, exact=False)
        y += 26

    def tool(name, detail, fill=BODY):
        nonlocal y
        svg.text(T, y, name, FAINT)
        svg.text(T + 7 * A, y, detail, fill)
        blocks[-1][3] = y
        y += 21

    def out(s, fill=FAINT, indent=7):
        nonlocal y
        svg.text(T + indent * A, y, s, fill)
        blocks[-1][3] = y
        y += 21

    def prompt(s):
        nonlocal y
        svg.text(X, y, ">", PROMPT)
        svg.text(X + 2 * A, y, s)
        blocks[-1][3] = y
        y += 25

    def gap(n=16):
        nonlocal y
        y += n

    step(1, "A SKILL HITS FRICTION · its last step applies skill-reflect.md")
    prompt("/release-notes v2.4.0")
    tool("Read", "CHANGELOG.md", BODY)
    out("file not found — it moved to docs/; drafting from git log instead", CRIT)
    tool("Bash", f"kaizen capture --check --skill {SKILL} --scope {SCOPE} --slug {SLUG}")
    # the real JSON line, broken after its first key so it fits; nothing else changes
    head, sep, rest = real["check"].partition(',"reason"')
    out(head + ",")
    out(sep[1:] + rest, indent=8)
    tool("Write", shown_path)
    out(reflection, OK)
    gap()

    step(2, "ANY LATER SESSION · the SessionStart hook prints one line, no model call")
    svg.text(X, y, real["status_one"], WARN)
    blocks[-1][3] = y
    y += 21
    gap()

    step(3, "/kaizen · one focused session repairs the backlog, grouped by the file to fix")
    prompt("/kaizen")
    tool("Bash", "kaizen list --by scope --text")
    for line in list_lines:
        out(line, BODY if not line.startswith(" ") else LABEL)
    tool("Edit", f"{SCOPE}   +{added} −{removed}")
    out("you approve every verdict and diff before anything is committed or closed", FAINT)
    tool("Bash", f'git commit -m "{COMMIT_SUBJECT}" \\')
    out(f'-m "{real["trailer"].strip()}"', ACCENT, indent=9)
    out(f"[main {real['sha']}] {COMMIT_SUBJECT}", FAINT)
    tool("Bash", f"kaizen close {ID} --fixed {real['sha']}")
    out(real["close"], OK)
    gap()

    step(4, "NEXT SESSION · the count is back down")
    svg.text(X, y, real["status_done"], OK)
    blocks[-1][3] = y
    y += 21

    svg.h = int(y + 10)
    # the rail: numbered steps joined top to bottom
    rail = 40
    for n, _, top, bottom in blocks:
        svg.raw(f'<circle cx="{rail}" cy="{top - 4}" r="10" fill="{CHROME}" stroke="{HAIR}"/>')
        svg.text(rail, top, str(n), LABEL, 11.5, anchor="middle", exact=False)
    for (_, _, top, _), (_, _, nxt, _) in zip(blocks, blocks[1:]):
        svg.line(rail, top + 7, rail, nxt - 15, HAIR)
    svg.frame("~/projects/web — one backlog, across Claude Code sessions")
    svg.write(
        "loop.svg",
        "A terminal showing the kaizen loop. First, a release-notes skill fails to find its "
        "changelog, runs kaizen capture --check, which finds no duplicate, and writes one "
        "suggestion file. In any later session the SessionStart hook prints kaizen: 1 open. "
        "Then /kaizen lists the backlog grouped by the file to fix, edits that skill, commits "
        "with a Kaizen-Suggestion trailer and closes the item with the commit sha, after which "
        "the hook prints kaizen: 0 open.",
    )


def suggestion_svg(real, spec):
    """The annotated suggestion file: what each part is and what reads it."""
    svg = Svg(1000, 0, 13)
    A = svg.adv
    X, NOTE = 40, 520
    y = 80
    svg.text(X, y - 18, "FILE", HEAD, 10.5, exact=False)
    svg.runs(X, y, [(f"{SHOWN_FEEDBACK}/", FAINT), (SKILL, KEY), ("/", FAINT), (FILE, BODY)])
    y += 19
    svg.text(X, y, f"{spec['path']} — one file per finding, never overwritten", LABEL, 12, exact=False)
    y += 28
    svg.runs(X, y, [("id  ", FAINT), ("user", ACCENT), (f"/{SKILL}/{FILE}", BODY)])
    y += 19
    svg.text(X, y, "<target>/<skill>/<file> — the name list, close and the commit trailer use",
             LABEL, 12, exact=False)
    notes = []
    y += 40
    svg.line(X, y - 18, svg.w - 40, y - 18)

    meaning = {
        "skill": "the folder and the category; list --by skill",
        "date": "the day it was captured",
        "outcome": " · ".join(spec["outcomes"]),
        "severity": " · ".join(spec["severity"]),
        "scope": "the file the fix lands in; list --by scope groups on it",
        "status": " · ".join(spec["statuses"]) + " — nothing else; unknown reads as open",
    }
    colour = {"severity": WARN, "status": OK}
    for raw in real["file"].rstrip("\n").split("\n"):
        if raw == "":
            y += 8
            continue
        if raw == "---":
            svg.text(X, y, raw, FAINT)
        elif ":" in raw and not raw.startswith("#") and raw.split(":")[0] in meaning:
            key, value = raw.split(": ", 1)
            svg.runs(X, y, [(f"{key}: ", KEY), (value, colour.get(key, BODY))])
            notes.append((y, meaning[key]))
        elif raw.startswith("## "):
            svg.text(X, y, raw, PROMPT)
            notes.append((y, {
                "Context": "what ran and what went wrong",
                "Suggestion": "the exact change to make",
                "Evidence": "the command, output or file:line that proves it",
            }[raw[3:]]))
        else:
            # wrap body text at the note column
            width = int((NOTE - 30 - X) / A)
            words, line = raw.split(), ""
            for word in words:
                if len(line) + len(word) + 1 > width:
                    svg.text(X, y, line, LABEL)
                    y += 19
                    line = word
                else:
                    line = f"{line} {word}".strip()
            svg.text(X, y, line, LABEL)
        y += 21
    for ny, note in notes:
        svg.line(NOTE - 22, ny - 4, NOTE - 8, ny - 4, HAIR)
        svg.text(NOTE, ny, note, LABEL, 12, exact=False)

    # what happens to the file later, from the CLI and the capture contract
    y += 8
    svg.line(X, y, svg.w - 40, y)
    y += 26
    svg.text(X, y, "LATER", HEAD, 10.5, exact=False)
    y += 22
    for head, fill, note in (
        ("## Recurrence — <YYYY-MM-DD>", PROMPT, "appended when the same problem happens again"),
        ("status: fixed  fixed_by: <sha>", OK, "kaizen close --fixed, plus closed_at and ## Resolution"),
        ("status: dropped  dropped_reason: …", FAINT, "kaizen close --dropped \"<reason>\""),
    ):
        svg.text(X, y, head, fill)
        svg.text(NOTE, y, note, LABEL, 12, exact=False)
        y += 21
    svg.h = int(y + 12)
    svg.frame("one suggestion, as skill-reflect.md writes it")
    svg.write(
        "suggestion.svg",
        "A kaizen suggestion file, annotated. Its path is the feedback folder, the skill name "
        "and a dated slug, and its id is target, skill and file name. The frontmatter holds "
        "skill, date, outcome, severity, the scope file the fix lands in, and a status that is "
        "only ever open, fixed or dropped. Context, Suggestion and Evidence sections follow. "
        "Later a Recurrence section is appended if the problem happens again, and kaizen close "
        "records fixed with a commit sha or dropped with a reason.",
    )


if __name__ == "__main__":
    spec = contract()
    real = real_run()
    IMAGES.mkdir(parents=True, exist_ok=True)
    loop_svg(real, spec)
    suggestion_svg(real, spec)
