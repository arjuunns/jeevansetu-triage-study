#!/usr/bin/env bash
# Python environments for the extension experiments (task 0). Run from the repo root.
set -euo pipefail
python3 -m venv research/.venv-ext
research/.venv-ext/bin/pip install --quiet --upgrade pip
research/.venv-ext/bin/pip install --quiet numpy scipy scikit-learn pypdf
research/.venv-ext/bin/pip freeze > research/results_ext/venv-ext.freeze.txt
echo "[$(date '+%F %T')] .venv-ext ready"
python3 -m venv research/.venv-rerank
research/.venv-rerank/bin/pip install --quiet --upgrade pip
research/.venv-rerank/bin/pip install --quiet torch sentence-transformers
research/.venv-rerank/bin/pip freeze > research/results_ext/venv-rerank.freeze.txt
echo "[$(date '+%F %T')] .venv-rerank ready"
