"""RAT engine: repository ingestion and metric computation.

Metrics follow the COMS3011A test specification:
- H = all non-merge commits reachable from HEAD (committer dates).
- Binary files are not measured (git numstat reports them as "-").
- Rename detection at the 50% similarity threshold; changes are attributed
  to the object's new path.
- Authors are resolved through the repository's .mailmap.

Multiple repositories are supported: each is stored under
``<RAT_DATA>/repos/<id>/`` with the checked-out repository, a parsed-record
cache and metadata. The active repository is persisted in
``<RAT_DATA>/active.json``.
"""

import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from collections import defaultdict
from io import BytesIO
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RAT_DATA", str(PROJECT_ROOT / "data")))
REPOS_DIR = DATA_DIR / "repos"
ACTIVE_FILE = DATA_DIR / "active.json"

COMMIT_RE = re.compile(r"^([0-9a-f]{40,64})\x1f(\d+)\x1f(.*)\x1f(.*)\x1f(.*)\x1f(.*)$")
RENAME_BRACES_RE = re.compile(r"^(.*)\{(.*) => (.*)\}(.*)$")


class IngestError(Exception):
    """User-facing ingestion failure."""


_state = {"repos": {}, "active": None}


def active_id():
    return _state["active"]


def has_repo(repo_id):
    return repo_id in _state["repos"]


def repo_list():
    out = []
    for repo_id in sorted(_state["repos"], key=lambda r: (_state["repos"][r]["metrics"]["name"], r)):
        m = _state["repos"][repo_id]["metrics"]
        out.append({
            "id": repo_id,
            "name": m["name"],
            "commit_count": m["commit_count"],
            "source": m["source"],
            "active": repo_id == _state["active"],
        })
    return out


def select_repo(repo_id):
    if repo_id not in _state["repos"]:
        raise IngestError(f"Unknown repository: {repo_id}")
    _state["active"] = repo_id
    ACTIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_FILE.write_text(json.dumps({"active": repo_id}), encoding="utf-8")


def current_metrics(repo_id=None):
    repo_id = repo_id if repo_id is not None else _state["active"]
    if repo_id is None:
        return None
    entry = _state["repos"].get(repo_id)
    return entry["metrics"] if entry else None


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
    path.mkdir(parents=True, exist_ok=True)


def _derive_name_from_url(url):
    name = url.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return name or "repository"


def _slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "repo"


def _new_repo_id(name):
    base = _slugify(name)
    candidate, n = base, 1
    while candidate in _state["repos"] or (REPOS_DIR / candidate).exists():
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def _slot(repo_id):
    return REPOS_DIR / repo_id


def _finalize_ingest(repo_id, name, source, incoming_repo):
    """Parse metrics from the staged repo, then move it into its slot."""
    records = _compute_records(incoming_repo)
    slot = _slot(repo_id)
    final_repo = slot / "repo"
    if final_repo.exists():
        shutil.rmtree(final_repo)
    shutil.move(str(incoming_repo), str(final_repo))
    (slot / "cache.json").write_text(json.dumps(records), encoding="utf-8")
    (slot / "meta.json").write_text(
        json.dumps({"name": name, "source": source}), encoding="utf-8")
    _state["repos"][repo_id] = {
        "records": records,
        "metrics": _aggregate(records, name, source),
    }
    select_repo(repo_id)
    return name


def _remove_empty_slot(repo_id):
    slot = _slot(repo_id)
    try:
        slot.rmdir()
    except OSError:
        pass


def _find_clone_target(url):
    """Re-ingesting the same URL replaces that repository's slot."""
    for repo_id, entry in _state["repos"].items():
        src = entry["metrics"].get("source") or {}
        if src.get("kind") == "clone" and src.get("url") == url:
            return repo_id
    return None


def ingest_clone(url):
    url = (url or "").strip()
    if not url:
        raise IngestError("Repository URL is required.")
    name = _derive_name_from_url(url)
    repo_id = _find_clone_target(url) or _new_repo_id(name)
    incoming = _slot(repo_id) / "incoming"
    _clean_path(incoming)
    proc = _run_git(["clone", url, str(incoming)])
    if proc.returncode != 0:
        shutil.rmtree(incoming, ignore_errors=True)
        _remove_empty_slot(repo_id)
        raise IngestError(f"git clone failed: {_tail(proc.stderr)}")
    _finalize_ingest(repo_id, name, {"kind": "clone", "url": url}, incoming)
    return repo_id


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


def ingest_zip(data, display_name="repository"):
    if not data:
        raise IngestError("Uploaded file is empty.")
    try:
        zf = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile:
        raise IngestError("Uploaded file is not a valid zip archive.")
    name = display_name or "repository"
    if name.lower().endswith(".zip"):
        name = name[:-4]
    repo_id = _new_repo_id(name)
    tmp = _slot(repo_id) / "extract"
    _clean_path(tmp)
    ok = False
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
        _finalize_ingest(repo_id, name, {"kind": "zip", "filename": display_name}, root)
        ok = True
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        if not ok:
            _remove_empty_slot(repo_id)
    return repo_id


def _rename_target(raw):
    if "=>" not in raw:
        return raw
    m = RENAME_BRACES_RE.match(raw)
    if m:
        return (m.group(1) + m.group(3) + m.group(4)).strip("/") or raw
    new = raw.rsplit("=>", 1)[1].strip()
    return new or raw


def _compute_records(repo_dir):
    proc = _run_git(["-C", str(repo_dir), "-c", "core.quotePath=false",
                     "log", "HEAD", "--no-merges", "--numstat",
                     "--find-renames=50%",
                     "--format=format:%H%x1f%ct%x1f%aN%x1f%aE%x1f%an%x1f%ae"])
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
                       "name": m.group(3), "email": m.group(4),
                       "raw_name": m.group(5), "raw_email": m.group(6),
                       "files": []}
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
    author_raws = defaultdict(lambda: defaultdict(int))
    raw_names = {}
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

        raw_email = rec["raw_email"].strip()
        raw_key = (raw_email or rec["raw_name"]).lower()
        author_raws[key][raw_key] += 1
        if raw_key not in raw_names:
            raw_names[raw_key] = {"name": rec["raw_name"], "email": raw_email}

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

    merged_authors = []
    for key in authors:
        raws = author_raws[key]
        if len(raws) > 1 or (len(raws) == 1 and key not in raws):
            merged_authors.append({
                "name": authors[key]["name"],
                "email": authors[key]["email"],
                "from": [dict(raw_names[rk], commits=raws[rk]) for rk in sorted(raws)],
            })
    merged_authors.sort(key=lambda m: m["name"])
    author_merging = {
        "raw_identity_count": len(raw_names),
        "author_count": len(authors),
        "merged_authors": merged_authors,
    }

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
        "author_merging": author_merging,
        "months": [months[k] for k in sorted(months)],
    }


def load_cached():
    _state["repos"] = {}
    _state["active"] = None
    if not REPOS_DIR.exists():
        return
    for slot in sorted(REPOS_DIR.iterdir()):
        if not slot.is_dir():
            continue
        repo_id = slot.name
        cache_f = slot / "cache.json"
        meta_f = slot / "meta.json"
        try:
            if cache_f.exists() and meta_f.exists():
                meta = json.loads(meta_f.read_text(encoding="utf-8"))
                records = json.loads(cache_f.read_text(encoding="utf-8"))
            elif (slot / "repo").exists():
                meta = {"name": repo_id, "source": {"kind": "unknown"}}
                records = _compute_records(slot / "repo")
            else:
                continue
            _state["repos"][repo_id] = {
                "records": records,
                "metrics": _aggregate(records, meta["name"], meta.get("source")),
            }
        except Exception:
            continue
    if ACTIVE_FILE.exists():
        try:
            active = json.loads(ACTIVE_FILE.read_text(encoding="utf-8")).get("active")
            if active in _state["repos"]:
                _state["active"] = active
        except Exception:
            pass
    if _state["active"] is None and _state["repos"]:
        first = sorted(_state["repos"])[0]
        _state["active"] = first
