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
    metrics = engine.current_metrics()
    if metrics is None:
        return jsonify({"loaded": False})
    return jsonify({
        "loaded": True,
        "name": metrics["name"],
        "source": metrics["source"],
        "commit_count": metrics["commit_count"],
    })


@app.post("/api/repos/url")
def api_repos_url():
    body = request.get_json(silent=True) or {}
    try:
        name = engine.ingest_clone(body.get("url"))
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "name": name})


@app.post("/api/repos/upload")
def api_repos_upload():
    name = request.args.get("name") or "repository"
    data = request.get_data()
    try:
        name = engine.ingest_zip(data, name)
    except engine.IngestError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "name": name})


@app.get("/api/metrics")
def api_metrics():
    metrics = engine.current_metrics()
    if metrics is None:
        return jsonify({"error": "No repository loaded. Clone a remote URL or upload a zip first."}), 409
    return jsonify(metrics)


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5000")), threaded=True)
