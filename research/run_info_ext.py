"""Records what the extension experiments ran on, in research/results_ext/run_info.json.

Called by research/run_ext.sh before every run with that run's evaluate_mimic.ts arguments, and
usable by hand:  python3 -I research/run_info_ext.py --model=qwen2.5:7b

It keeps, and never overwrites, the first record of each model: Ollama digest, quantisation and
parameter count as Ollama reports them, and when the model was first used. If a model's digest
later differs from the recorded one, it stops with an error, so two builds of a model cannot be
mixed in one set of results. Standard library only; talks only to the local Ollama server.
"""

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "research" / "results_ext" / "run_info.json"
BASE = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11535")


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def main():
    model = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--model=")), None)
    info = json.loads(OUT.read_text()) if OUT.exists() else {}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    info.setdefault("firstRun", now)
    info["lastRun"] = now
    info["host"] = sh("hostname")
    info["gpu"] = sh("nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader")
    info["gpuDevices"] = sh("nvidia-smi", "-L").splitlines()
    info["ollama"] = api("/api/version")["version"]
    # The main server (port 11535) keeps its models in /workspace/ollama-models. The 8-bit check (task 6)
    # ran on a second server (port 11537, same binary and settings) whose models sit on the server's local
    # disk, because /workspace had no room for the 29.6 GB model; run_precision.sh sets OLLAMA_MODELS_DIR.
    server = {
        "url": BASE,
        "OLLAMA_MODELS": os.environ.get("OLLAMA_MODELS_DIR", "/workspace/ollama-models"),
        "OLLAMA_NUM_PARALLEL": 1,
        "OLLAMA_MAX_LOADED_MODELS": 1,
    }
    if BASE == "http://127.0.0.1:11535":
        info["ollamaServer"] = server
    else:
        info.setdefault("otherOllamaServers", {})[BASE] = server
    info["settings"] = {"temperature": 0, "seed": 42, "numCtx": int(os.environ.get("OLLAMA_NUM_CTX", "8192"))}
    info["node"] = sh("node", "-v")
    commits = info.setdefault("gitCommits", [])
    commit = sh("git", "-C", str(ROOT), "rev-parse", "--short", "HEAD")
    if commit and commit not in commits:
        commits.append(commit)
    if model:
        tags = {m["name"]: m for m in api("/api/tags")["models"]}
        tag = tags.get(model) or tags.get(model + ":latest")
        if not tag:
            raise SystemExit(f"{model} is not pulled")
        details = api("/api/show", {"model": model}).get("details", {})
        record = {
            "digest": tag["digest"],
            "quantization": details.get("quantization_level"),
            "parameters": details.get("parameter_size"),
            "family": details.get("family"),
            "sizeBytes": tag.get("size"),
            "server": BASE,
            "firstUsed": now,
        }
        models = info.setdefault("models", {})
        if model in models and models[model]["digest"] != record["digest"]:
            raise SystemExit(f"{model}: digest {record['digest']} differs from the recorded {models[model]['digest']}")
        models.setdefault(model, record)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps(info.get("models", {}).get(model, info), indent=2))


if __name__ == "__main__":
    main()
