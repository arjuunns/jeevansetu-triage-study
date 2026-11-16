"""Local cross-encoder reranker for the retrieval cache builder.

Replaces the Gemini rerank step (build_retrieval_cache.ts --rerank=local), so
retrieval needs no cloud service and no patient data leaves the machine.

    research/.venv-rerank/bin/python research/rerank_server.py [--device cpu|mps|cuda] [--port 8765]

Endpoints (127.0.0.1 only):
    GET  /info    -> {"model", "revision", "device", "max_length"}
    POST /rerank  {"query": str, "documents": [str]} -> {"scores": [float]}

Scores are the cross-encoder's sigmoid relevance scores (higher = more relevant).
CPU is the default because it gives identical scores on every run; use cuda on
the GPU server for speed.

Setup:  uv venv --python 3.12 research/.venv-rerank
        uv pip install --python research/.venv-rerank/bin/python torch sentence-transformers
"""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
from sentence_transformers import CrossEncoder

MODEL = "BAAI/bge-reranker-v2-m3"
MAX_LENGTH = 1024  # query + passage tokens; passages are at most 2,000 characters

parser = argparse.ArgumentParser()
parser.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
parser.add_argument("--port", type=int, default=8765)
parser.add_argument("--batch-size", type=int, default=8)
args = parser.parse_args()

torch.manual_seed(0)
model = CrossEncoder(MODEL, max_length=MAX_LENGTH, device=args.device)
model.model.eval()
revision = getattr(model.model.config, "_commit_hash", None)
if not revision:  # read the snapshot the weights were loaded from
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        with open(os.path.join(HF_HUB_CACHE, "models--" + MODEL.replace("/", "--"), "refs", "main")) as f:
            revision = f.read().strip()
    except OSError:
        revision = "unknown"
INFO = {"model": MODEL, "revision": revision, "device": args.device, "max_length": MAX_LENGTH}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/info":
            self._send(200, INFO)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/rerank":
            self._send(404, {"error": "not found"})
            return
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            query, docs = req["query"], req["documents"]
            if not isinstance(query, str) or not isinstance(docs, list) or not all(isinstance(d, str) for d in docs):
                raise ValueError("expected {query: str, documents: [str]}")
            with torch.inference_mode():
                scores = model.predict([(query, d) for d in docs], batch_size=args.batch_size, show_progress_bar=False)
            self._send(200, {"scores": [float(s) for s in scores]})
        except Exception as err:  # report the error to the caller instead of dropping the connection
            self._send(400, {"error": str(err)})

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    print(f"Reranker ready on http://127.0.0.1:{args.port}  {INFO}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
