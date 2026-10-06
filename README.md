# RAT — Repo Analysis Tool

A web dashboard that computes and displays metrics for Git repositories
(COMS3011A Test).

## Quick start

Requires Python 3.9+, Git, and Flask.

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

Then open <http://127.0.0.1:5000>.

Configuration (all optional):

| Variable   | Default    | Purpose                                          |
|------------|------------|--------------------------------------------------|
| `PORT`     | `5000`     | Server port                                      |
| `HOST`     | `127.0.0.1`| Bind address                                     |
| `RAT_DATA` | `./data`   | Directory for ingested repositories and the cache |

For development with auto-reload, point the data directory outside the
project so the file watcher ignores analysed repositories:

```bash
RAT_DATA=/tmp/rat-data python3 -m flask --app server run --debug
```

## Usage

Ingest a repository either by:

1. **Remote URL** — the repository is deeply cloned (full history) and analysed.
2. **Zip upload** — a zip of the repository *including its `.git` directory*.

Repositories are **kept in a registry**: each one you analyse stays in the
repository selector in the header, and the most recently analysed one becomes
active. Switch between them at any time — metrics for every registered
repository are cached, so switching is instant. Re-analysing the same remote
URL replaces that repository's entry.

The dashboard shows metrics for the active repository:

- **Repository metrics** — metrics of the root directory over the commit set.
- **File metrics** — per file.
- **Directory metrics** — per directory (recursive over descendant files).
- **Commit set metrics** — added, removed, growth, churn, modifications,
  modification frequency and churn rate over the commit set
  `H` = all non-merge commits reachable from `HEAD`.
- **Author metrics** — modifications, churn and ownership per author.

## Metric semantics

- Binary files are not measured (git reports them as `-` in numstat).
- Merge commits are excluded; commits are identified by committer date.
- Renames are detected at the 50% similarity threshold; changes are attributed
  to the object's new path, and deletions count as removed lines.
- Authors are resolved through the repository's `.mailmap`: when several raw
  identities map to one canonical author they are merged (the Authors tab shows
  how many raw identities were resolved and which were merged).

## Implementation

Python 3 + Flask backend; git is invoked once per repository
(`git log --numstat --find-renames=50% --no-merges` with both raw and
mailmap-resolved author identities in the format string), parsed into
per-commit records, aggregated in a single pass and cached under
`RAT_DATA/repos/<id>/` (in-memory + JSON on disk), so metric queries and
repository switching are served instantly.
The frontend is vanilla JavaScript + vendored Chart.js — no build step, no
database.
