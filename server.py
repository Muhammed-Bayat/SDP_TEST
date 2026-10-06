"""RAT web server."""

import os

from flask import Flask, jsonify, request, send_from_directory

import engine

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = None

engine.load_cached()


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/state")
def api_state():
    repos = engine.repo_list()
    return jsonify({
        "loaded": bool(repos and engine.active_id() is not None),
        "repos": repos,
        "active": engine.active_id(),
    })


@app.post("/api/repos/url")
def api_repos_url():
    body = request.get_json(silent=True) or {}
    try:
        repo_id = engine.ingest_clone(body.get("url"))
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "id": repo_id})


@app.post("/api/repos/upload")
def api_repos_upload():
    name = request.args.get("name") or "repository"
    data = request.get_data()
    try:
        repo_id = engine.ingest_zip(data, name)
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "id": repo_id})


@app.post("/api/repos/select")
def api_repos_select():
    body = request.get_json(silent=True) or {}
    repo_id = body.get("id")
    if not repo_id or not engine.has_repo(repo_id):
        return jsonify({"error": f"Unknown repository: {repo_id}"}), 404
    try:
        engine.select_repo(repo_id)
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True})


@app.get("/api/metrics")
def api_metrics():
    repo_id = request.args.get("repo")
    if repo_id is not None and not engine.has_repo(repo_id):
        return jsonify({"error": f"Unknown repository: {repo_id}"}), 404
    filters = {k: request.args.get(k) for k in ("author", "path", "start", "end")}
    try:
        if any(filters.values()):
            metrics = engine.filtered_metrics(repo_id, **filters)
        else:
            metrics = engine.current_metrics(repo_id)
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    if metrics is None:
        return jsonify({"error": "No repository loaded. Clone a remote URL or upload a zip first."}), 409
    return jsonify(metrics)


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5000")), threaded=True)
