"""RAT engine: repository ingestion and metric computation.

Metrics follow the COMS3011A test specification:
- H = all non-merge commits reachable from HEAD (committer dates).
- Binary files are not measured (git numstat reports them as "-").
- Rename detection at the 50% similarity threshold; changes are attributed
  to the object's new path.
- Authors are resolved through the repository's .mailmap.
"""

import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from io import BytesIO
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RAT_DATA", str(PROJECT_ROOT / "data")))
REPO_DIR = DATA_DIR / "repo"
CACHE_FILE = DATA_DIR / "cache.json"
META_FILE = DATA_DIR / "meta.json"

COMMIT_RE = re.compile(r"^([0-9a-f]{40,64})\x1f(\d+)\x1f(.*)\x1f(.*)$")
RENAME_BRACES_RE = re.compile(r"^(.*)\{(.*) => (.*)\}(.*)$")


class IngestError(Exception):
    """User-facing ingestion failure."""


_state = {"records": None, "metrics": None}


def current_metrics():
    return _state["metrics"]


def _git_env():
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _run_git(args, cwd=None):
    cmd = ["git", "--no-pager", *args]
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                         encoding="utf-8", errors="replace", env=_git_env())


def _tail(text, limit=400):
    text = (text or "").strip()
    return text[-limit:]


def _clean_path(path):
    if path.exists():
        shutil.rmtree(path)
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _derive_name_from_url(url):
    name = url.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return name or "repository"


def _finish(name, source):
    records = _compute_records()
    CACHE_FILE.write_text(json.dumps(records), encoding="utf-8")
    META_FILE.write_text(json.dumps({"name": name, "source": source}), encoding="utf-8")
    _state["records"] = records
    _state["metrics"] = _aggregate(records, name, source)


def ingest_clone(url):
    url = (url or "").strip()
    if not url:
        raise IngestError("Repository URL is required.")
    incoming = DATA_DIR / "incoming"
    _clean_path(incoming)
    proc = _run_git(["clone", url, str(incoming)])
    if proc.returncode != 0:
        _clean_path(incoming)
        raise IngestError(f"git clone failed: {_tail(proc.stderr)}")
    _swap_repo(incoming)
    name = _derive_name_from_url(url)
    _finish(name, {"kind": "clone", "url": url})
    return name


def _extract_zip(zf, dest):
    for info in zf.infolist():
        name = info.filename
        if name.startswith("/") or ".." in Path(name).parts:
            raise IngestError(f"Refusing unsafe path in zip: {name}")
        target = dest / name
        if info.is_dir() or name.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _locate_repo_root(extract_dir):
    if (extract_dir / ".git").exists():
        return extract_dir
    children = [p for p in extract_dir.iterdir() if p.is_dir()]
    if len(children) == 1 and (children[0] / ".git").exists():
        return children[0]
    return None


def _swap_repo(incoming):
    """Replace the currently stored repo with a validated incoming one."""
    if REPO_DIR.exists():
        shutil.rmtree(REPO_DIR)
    shutil.move(str(incoming), str(REPO_DIR))


def ingest_zip(data, display_name="repository"):
    if not data:
        raise IngestError("Uploaded file is empty.")
    try:
        zf = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile:
        raise IngestError("Uploaded file is not a valid zip archive.")
    tmp = DATA_DIR / "extract"
    _clean_path(tmp)
    try:
        _extract_zip(zf, tmp)
        root = _locate_repo_root(tmp)
        if root is None:
            raise IngestError(
                "No .git directory found in the zip. The zip must contain the "
                "repository including its .git directory.")
        if (root / ".git").is_file():
            raise IngestError(
                "The zip contains .git as a pointer file (a linked worktree). "
                "A full .git directory is required.")
        _swap_repo(root)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    name = display_name or "repository"
    if name.lower().endswith(".zip"):
        name = name[:-4]
    _finish(name, {"kind": "zip", "filename": display_name})
    return name


def _rename_target(raw):
    if "=>" not in raw:
        return raw
    m = RENAME_BRACES_RE.match(raw)
    if m:
        return (m.group(1) + m.group(3) + m.group(4)).strip("/") or raw
    new = raw.rsplit("=>", 1)[1].strip()
    return new or raw


def _compute_records():
    proc = _run_git(["-C", str(REPO_DIR), "-c", "core.quotePath=false",
                     "log", "HEAD", "--no-merges", "--numstat",
                     "--find-renames=50%", "--use-mailmap",
                     "--format=format:%H%x1f%ct%x1f%aN%x1f%aE"])
    if proc.returncode != 0:
        raise IngestError(f"Failed to read git history: {_tail(proc.stderr)}")
    records = []
    current = None
    for line in proc.stdout.splitlines():
        if not line:
            continue
        m = COMMIT_RE.match(line)
        if m:
            current = {"h": m.group(1), "ts": int(m.group(2)),
                      "name": m.group(3), "email": m.group(4), "files": []}
            records.append(current)
            continue
        if current is None:
            continue
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        added, removed, raw_path = parts
        if added == "-" or removed == "-":
            continue
        path = _rename_target(raw_path)
        if not path:
            continue
        current["files"].append([path, int(added), int(removed)])
    return records


def _parent(path):
    i = path.rfind("/")
    return path[:i] if i > 0 else ""


def _zero(path):
    return {"path": path, "added": 0, "removed": 0, "mods": 0}


def _aggregate(records, name, source):
    H = len(records)
    stat = {}
    file_paths = set()
    dir_paths = {""}
    authors = {}
    months = {}
    first_ts = None
    last_ts = None

    for rec in records:
        ts = rec["ts"]
        if first_ts is None or ts < first_ts:
            first_ts = ts
        if last_ts is None or ts > last_ts:
            last_ts = ts

        email = rec["email"].strip()
        key = (email or rec["name"]).lower()
        author = authors.setdefault(key, {
            "name": rec["name"], "email": email,
            "commits": 0, "churn": 0, "mods": 0, "ownership": 0.0})
        author["commits"] += 1

        month = time.strftime("%Y-%m", time.gmtime(ts))
        mrec = months.setdefault(
            month, {"month": month, "added": 0, "removed": 0, "commits": 0})
        mrec["commits"] += 1

        touched = set()
        commit_churn = 0
        for path, added, removed in rec["files"]:
            fs = stat.setdefault(path, _zero(path))
            fs["added"] += added
            fs["removed"] += removed
            file_paths.add(path)
            mrec["added"] += added
            mrec["removed"] += removed
            commit_churn += added + removed

            dirs_of = []
            d = _parent(path)
            while True:
                dirs_of.append(d)
                if d == "":
                    break
                d = _parent(d)
            for d in dirs_of:
                ds = stat.setdefault(d, _zero(d))
                ds["added"] += added
                ds["removed"] += removed
                dir_paths.add(d)
            if added + removed > 0:
                touched.add(path)
                touched.update(dirs_of)

        for obj in touched:
            stat[obj]["mods"] += 1
        if commit_churn > 0:
            author["mods"] += 1
        author["churn"] += commit_churn

    stat.setdefault("", _zero(""))

    def finalize(st):
        st["growth"] = st["added"] - st["removed"]
        st["churn"] = st["added"] + st["removed"]
        st["freq"] = (st["mods"] / H) if H else 0.0
        st["rate"] = (st["churn"] / H) if H else 0.0
        return st

    files = sorted((finalize(stat[p]) for p in file_paths),
                   key=lambda s: (-s["churn"], s["path"]))
    dirs = sorted((finalize(stat[p]) for p in dir_paths),
                  key=lambda s: (-s["churn"], s["path"]))
    root = finalize(stat.get("", _zero("")))

    author_list = []
    for a in authors.values():
        a["ownership"] = (a["churn"] / root["churn"]) if root["churn"] else 0.0
        author_list.append(a)
    author_list.sort(key=lambda a: (-a["churn"], a["name"], a["email"]))

    return {
        "name": name,
        "source": source,
        "commit_count": H,
        "first_commit": first_ts,
        "last_commit": last_ts,
        "repo": root,
        "files": files,
        "dirs": dirs,
        "authors": author_list,
        "months": [months[k] for k in sorted(months)],
    }


def load_cached():
    if not REPO_DIR.exists():
        return
    try:
        if CACHE_FILE.exists() and META_FILE.exists():
            meta = json.loads(META_FILE.read_text(encoding="utf-8"))
            records = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        else:
            meta = {"name": "repository", "source": {"kind": "unknown"}}
            records = _compute_records()
        _state["records"] = records
        _state["metrics"] = _aggregate(records, meta["name"], meta.get("source"))
    except Exception:
        _state["records"] = None
        _state["metrics"] = None
