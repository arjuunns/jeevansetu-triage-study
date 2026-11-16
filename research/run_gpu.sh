#!/usr/bin/env bash
# Gemma 3 27B and MedGemma 27B through every setup of the study, on a GPU server, with exactly
# the pipeline of the laptop runs (pipeline v2: corrected ESI guide, ESI v4 handbook corpus,
# local-reranker retrieval cache). Written 11 Nov 2026.
#
# On the GPU server (Linux, NVIDIA GPU with 24 GB or more, internet access for the downloads):
#   git clone <this repository>
#   cd JeevanSetu
#   tmux new -s triage                  # keeps it running if the SSH connection drops
#   bash research/run_gpu.sh            # then detach with Ctrl-b d; reattach with: tmux attach -t triage
#
#   bash research/run_gpu.sh check      # only the checks and installs, no model downloads or runs
#   Without tmux:  nohup bash research/run_gpu.sh >/dev/null 2>&1 &   and follow:  tail -f research/run_gpu.log
#   On a cluster with a job scheduler, run it inside a GPU job (for example: srun --gres=gpu:1 --pty bash).
#
# What it does:
#   1. Checks that the cohort, retrieval cache, ESI guide and system prompt are identical to the
#      laptop runs (fingerprints below); stops otherwise.
#   2. Installs what is missing, without root, under ~/.cache/jeevansetu: Node.js 22, the server's
#      packages (pnpm) and Ollama 0.32.14, the version used on the laptop.
#   3. Starts its own Ollama server on 127.0.0.1:11535 (leaves any other Ollama alone) and checks
#      that the model loads on the GPU.
#   4. Pulls gemma3:27b and medgemma:27b (official Ollama builds, Q4_K_M, about 17 GB each).
#   5. Per model: a 2-patient smoke test, then the 7 setups on all 207 visits. A model that cannot
#      give valid answers in the smoke test is skipped, as MedGemma 4B was. Running the script again
#      resumes where it stopped; finished patients are kept.
#   6. Runs research/analyze.py and packs the results into research/gpu_results_<date>.tar.gz.
#
# No patient data leaves the server: the only network use is downloading Node.js, packages, Ollama
# and the models.
#
# Optional settings (environment variables):
#   MODELS="gemma3:27b medgemma:27b"      models to run
#   OLLAMA_MODELS=/path                   where models are stored (default ~/.ollama/models; ~35 GB)
#   OLLAMA_PORT=11535                     port of this script's Ollama server
#   USE_EXISTING_OLLAMA=http://host:port  use an Ollama server that is already running instead
#   STALL_MINUTES=30                      stop a run if no patient finishes for this long
#   ALLOW_CPU=1                           continue even if the model does not fit on the GPU (very slow)
#   LIMIT=N                               testing only: first N patients per run

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/apps/server"
MODE="${1:-run}"
case "$MODE" in
  run | check) ;;
  *) echo "usage: bash research/run_gpu.sh [run|check]" >&2; exit 64 ;;
esac

read -r -a MODEL_LIST <<< "${MODELS:-gemma3:27b medgemma:27b}"
OLLAMA_VERSION="0.32.14"
NODE_VERSION="22.23.4"
PNPM_VERSION="10.33.4"
OLLAMA_PORT="${OLLAMA_PORT:-11535}"
STALL_MINUTES="${STALL_MINUTES:-30}"
LIMIT="${LIMIT:-}"
TOOLS="${JEEVANSETU_TOOLS:-$HOME/.cache/jeevansetu}"
OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-$HOME/.ollama/models}"
LOG="$ROOT/research/run_gpu.log"
RUN_LOGS="$ROOT/research/gpu_logs"
CACHE="$ROOT/research/retrieval_cache.v2.json"
COHORT="$ROOT/data/mimic_ed_cohort.json"
TSX="$SERVER/node_modules/.bin/tsx"

# Fingerprints of the laptop runs (pipeline v2). Different files would give results that cannot be
# compared with the other models, so the script stops if any of these differ.
EXPECT_COHORT_SHA256="6de44f333343bac92db26114f963485cbbc862f4c2589cf10adae27378ca5c0b"
EXPECT_CACHE_SHA256="fd56ccaf83ff4f44cc323dd5c8c8235c895c3a58c21f86da3f3ef53f97eb7581"
EXPECT_GUIDE_SHA="f95fddba59552235"   # sha256 of the ESI guide text, first 16 hex digits (as in the run files)
EXPECT_PROMPT_SHA="87295fd016286c01"  # sha256 of the system prompt, first 16 hex digits

# The 7 setups, in the order of the laptop runs' tables.
SETUP_FLAGS=(
  "--rag=off --safety=off"
  "--rag=off --safety=on"
  "--rag=off --safety=on --safety-notice=off"
  "--rag=off --safety=off --guide=on"
  "--rag=off --safety=on --guide=on"
  "--rag=on --safety=off"
  "--rag=on --safety=on"
)
SETUP_NAMES=("LLM only" "+ safety" "+ safety, no notice" "+ ESI guide" "+ ESI guide + safety" "+ RAG" "Full (RAG + safety)")

mkdir -p "$ROOT/research" "$RUN_LOGS" "$TOOLS"
exec > >(tee -a "$LOG") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "STOP: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
slug() { printf '%s' "$1" | sed -E 's/[^a-zA-Z0-9.]+/-/g'; }

sha256_file() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
  fi
}

free_gb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024 / 1024) }'; }

# Kill a process and all its children (tsx starts node as a child process).
kill_tree() {
  local p=$1 c
  for c in $(ps -eo pid=,ppid= | awk -v p="$p" '$2 == p { print $1 }'); do kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null
}

OLLAMA_PID=""
CURRENT_PID=""
cleanup() {
  [ -n "$CURRENT_PID" ] && kill_tree "$CURRENT_PID"
  if [ -n "$OLLAMA_PID" ]; then
    kill "$OLLAMA_PID" 2>/dev/null && log "Stopped this script's Ollama server."
  fi
}
trap cleanup EXIT
trap 'log "Interrupted. Run the script again to resume."; exit 130' INT TERM HUP

# ---------------------------------------------------------------- small Python helpers (stdlib only)
PULL_PY=$(cat <<'PY'
import json, sys, time
last, status = 0.0, ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    if "error" in d:
        print("  error: " + str(d["error"]), flush=True)
        sys.exit(1)
    s = d.get("status", "")
    total, done = d.get("total"), d.get("completed")
    if total and done:
        if time.time() - last > 30:
            print("  %s: %.0f%% of %.1f GB" % (s[:32], 100.0 * done / total, total / 1e9), flush=True)
            last = time.time()
    elif s != status:
        print("  " + s, flush=True)
    status = s
PY
)
TAGS_PY=$(cat <<'PY'
import json, sys
want = sys.argv[1]
for m in json.load(sys.stdin).get("models", []):
    if m["name"] in (want, want + ":latest"):
        print(m.get("digest", ""))
        sys.exit(0)
sys.exit(1)
PY
)
SHOW_PY=$(cat <<'PY'
import json, sys
d = json.load(sys.stdin).get("details", {})
print(d.get("quantization_level", "?"), d.get("parameter_size", "?"))
PY
)
PS_PY=$(cat <<'PY'
import json, sys
want = sys.argv[1]
for m in json.load(sys.stdin).get("models", []):
    if m["name"] in (want, want + ":latest"):
        size, vram = m.get("size", 0), m.get("size_vram", 0)
        print("%.1f of %.1f GB in GPU memory" % (vram / 1e9, size / 1e9))
        sys.exit(0 if vram >= size else (3 if vram > 0 else 4))
print("model is not loaded")
sys.exit(5)
PY
)
STATUS_PY=$(cat <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    print("no result file")
    sys.exit(2)
c = d["counts"]
print("%d of %d patients (ok %d, fallback %d, error %d)%s" % (
    c["done"], c["total"], c["ok"], c["fallback"], c["error"], "" if d["complete"] else ", not finished"))
if len(sys.argv) > 2:  # smoke test: every answer must be a valid model answer
    sys.exit(0 if d["complete"] and c["ok"] == c["total"] else 1)
sys.exit(0 if d["complete"] and c["error"] == 0 else 1)
PY
)
UNZST_PY=$(cat <<'PY'
# Unpacks a .tar.zst without the zstd tool: Python 3.14's zstd module, or the zstandard package
# (pip, or its wheel fetched straight from PyPI when pip is missing).
import importlib, io, json, os, platform, subprocess, sys, tarfile, zipfile
src, dest, tools = sys.argv[1], sys.argv[2], sys.argv[3]
target = os.path.join(tools, "py")
os.makedirs(target, exist_ok=True)  # must exist before the first import, so the cache below can be refreshed
sys.path.insert(0, target)


def fetch(url):
    # curl, not urllib: curl falls back from IPv6 to IPv4 by itself, urllib can hang on broken IPv6.
    return subprocess.run(["curl", "-fsSL", "--retry", "3", "--connect-timeout", "30", url],
                          check=True, stdout=subprocess.PIPE).stdout


def wheel_from_pypi():
    tag = "cp%d%d" % sys.version_info[:2]
    machine = platform.machine()
    meta = json.loads(fetch("https://pypi.org/pypi/zstandard/json"))
    for f in meta["urls"]:
        name = f["filename"]
        if name.endswith(".whl") and "-%s-%s-" % (tag, tag) in name and "manylinux" in name and machine in name:
            zipfile.ZipFile(io.BytesIO(fetch(f["url"]))).extractall(target)
            return


try:
    from compression import zstd  # Python 3.14 and later
    stream = zstd.open(src, "rb")
except ImportError:
    try:
        import zstandard
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--target", target, "zstandard"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        importlib.invalidate_caches()  # Python caches folder listings; without this the new package is not found
        try:
            import zstandard
        except ImportError:
            try:
                wheel_from_pypi()
                importlib.invalidate_caches()
                import zstandard
            except Exception:
                sys.exit("cannot unpack .tar.zst: install zstd (sudo apt install zstd, or conda install zstd) and run again")
    stream = zstandard.ZstdDecompressor().stream_reader(open(src, "rb"))
with tarfile.open(fileobj=stream, mode="r|") as t:
    t.extractall(dest)
PY
)
INFO_PY=$(cat <<'PY'
import json, sys
out, pairs = sys.argv[1], sys.argv[2:]
info = {}
for p in pairs:
    k, _, v = p.partition("=")
    if k.startswith("model:"):
        info.setdefault("models", {})[k[6:]] = v
    else:
        info[k] = v
with open(out, "w") as f:
    json.dump(info, f, indent=2)
    f.write("\n")
PY
)

# ---------------------------------------------------------------- 1. checkout and toolchain
log "=== run_gpu.sh $MODE: $(hostname), models: ${MODEL_LIST[*]} ==="
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) NODE_ARCH=x64; OLLAMA_ARCH=amd64 ;;
  aarch64 | arm64) NODE_ARCH=arm64; OLLAMA_ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $ARCH" ;;
esac
case "$OS" in
  Linux) NODE_OS=linux ;;
  Darwin) NODE_OS=darwin ;;
  *) die "unsupported operating system: $OS" ;;
esac
for t in curl tar python3 awk sed; do have "$t" || die "$t is not installed"; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "Python 3.8 or newer is needed"

[ -f "$COHORT" ] || die "data/mimic_ed_cohort.json is missing: run this from a full clone of the repository"
[ -f "$CACHE" ] || die "research/retrieval_cache.v2.json is missing: clone the main branch of the repository"
[ "$(sha256_file "$COHORT")" = "$EXPECT_COHORT_SHA256" ] || die "data/mimic_ed_cohort.json differs from the laptop runs"
[ "$(sha256_file "$CACHE")" = "$EXPECT_CACHE_SHA256" ] || die "research/retrieval_cache.v2.json differs from the laptop runs"
log "Cohort and retrieval cache match the laptop runs."

# Downloads with resume: a stalled transfer (under 20 kB/s for 2 minutes) is restarted from where
# it stopped, up to 6 times. A file that fails to unpack is deleted so the next run starts afresh.
download() {
  local url=$1 out=$2 try
  for try in 1 2 3 4 5 6; do
    curl -fL --connect-timeout 30 --speed-limit 20000 --speed-time 120 -C - --progress-bar -o "$out" "$url" && return 0
    log "Download interrupted (attempt $try of 6); resuming in 15 s"
    sleep 15
  done
  return 1
}

node_major() { "$1" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if have node && [ "$(node_major node)" -ge 20 ] 2>/dev/null; then
  NODE="$(command -v node)"
else
  NODE_DIR="$TOOLS/node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    log "Downloading Node.js $NODE_VERSION"
    download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.gz" "$TOOLS/node.tar.gz" \
      || die "Node.js download failed (check the internet connection, then run the script again)"
    tar -xzf "$TOOLS/node.tar.gz" -C "$TOOLS" || { rm -f "$TOOLS/node.tar.gz"; die "could not unpack Node.js; run the script again"; }
    rm -f "$TOOLS/node.tar.gz"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  NODE="$NODE_DIR/bin/node"
fi
log "Node.js $("$NODE" -v) ($NODE)"

PNPM=(npx --yes "pnpm@$PNPM_VERSION")
if have pnpm && [ "$(pnpm --version 2>/dev/null | cut -d. -f1)" -ge 9 ] 2>/dev/null; then PNPM=(pnpm); fi
if [ ! -x "$TSX" ]; then
  log "Installing the server's packages with pnpm (first run only, a few minutes)"
  (cd "$ROOT" && HUSKY=0 CI=true "${PNPM[@]}" install --frozen-lockfile --filter "@jeevansetu/server...") \
    || die "pnpm install failed (see above)"
fi
[ -x "$TSX" ] || die "tsx is missing after the install"
if [ ! -f "$ROOT/packages/types/dist/index.js" ]; then
  # The repository holds a TypeScript build cache (tsbuildinfo) for this package, which makes tsc
  # skip the build in a fresh clone, so build with a cache file of our own.
  log "Building the shared types package (@jeevansetu/types)"
  rm -f "$TOOLS/types-build.tsbuildinfo"
  (cd "$ROOT/packages/types" && ./node_modules/.bin/tsc -p tsconfig.build.json --tsBuildInfoFile "$TOOLS/types-build.tsbuildinfo") \
    || die "building @jeevansetu/types failed (see above)"
  [ -f "$ROOT/packages/types/dist/index.js" ] || die "building @jeevansetu/types gave no dist/index.js"
fi

# Settings for the triage code. DATABASE_URL is required by the server's config schema, but the
# evaluation never connects to a database. num_ctx 8192 as on the laptop.
export DATABASE_URL="${DATABASE_URL:-postgresql://unused:unused@127.0.0.1:5432/unused}"
export OLLAMA_NUM_CTX=8192
export LOG_LEVEL="${LOG_LEVEL:-info}"

fingerprints() { (cd "$SERVER" && "$TSX" scripts/gpu_fingerprints.ts 2>&1) | grep '^FINGERPRINTS ' | tail -1; }
FP="$(fingerprints)"
if [ -z "$FP" ]; then
  log "Generating the Prisma client (the triage code imports it; no database is used)"
  (cd "$SERVER" && ./node_modules/.bin/prisma generate) || die "prisma generate failed (see above)"
  FP="$(fingerprints)"
  if [ -z "$FP" ]; then
    (cd "$SERVER" && "$TSX" scripts/gpu_fingerprints.ts)
    die "the triage code does not load (error above)"
  fi
fi
read -r _ GUIDE_SHA PROMPT_SHA <<< "$FP"
[ "$GUIDE_SHA" = "$EXPECT_GUIDE_SHA" ] || die "the ESI guide differs from the laptop runs ($GUIDE_SHA): wrong branch?"
[ "$PROMPT_SHA" = "$EXPECT_PROMPT_SHA" ] || die "the system prompt differs from the laptop runs ($PROMPT_SHA): wrong branch?"
log "ESI guide ($GUIDE_SHA) and system prompt ($PROMPT_SHA) match the laptop runs."

# ---------------------------------------------------------------- 2. GPU and Ollama
GPU_INFO=""
if have nvidia-smi; then
  GPU_INFO="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | paste -sd ';' -)"
fi
if [ -n "$GPU_INFO" ]; then
  log "GPU: $GPU_INFO"
elif [ "$OS" = Darwin ]; then
  GPU_INFO="Apple silicon (Metal)"
  log "GPU: $GPU_INFO"
elif [ -n "${ALLOW_CPU:-}" ]; then
  GPU_INFO="none (CPU)"
  log "WARNING: no NVIDIA GPU visible; continuing on the CPU because ALLOW_CPU is set (very slow)."
else
  die "no NVIDIA GPU visible (nvidia-smi). On a cluster, run this inside a GPU job, e.g. srun --gres=gpu:1 --pty bash. ALLOW_CPU=1 runs on the CPU (very slow)."
fi

api_version() { curl -fsS -m 5 "$1/api/version" 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])' 2>/dev/null; }
ollama_bin_version() { OLLAMA_HOST=127.0.0.1:9 "$1" -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1; }

if [ -n "${USE_EXISTING_OLLAMA:-}" ]; then
  OLLAMA_URL="${USE_EXISTING_OLLAMA%/}"
  SERVER_VERSION="$(api_version "$OLLAMA_URL")"
  [ -n "$SERVER_VERSION" ] || die "no Ollama server answers at $OLLAMA_URL"
  [ "$SERVER_VERSION" = "$OLLAMA_VERSION" ] \
    || log "WARNING: Ollama $SERVER_VERSION at $OLLAMA_URL; the laptop runs used $OLLAMA_VERSION. Report this with the results."
  log "Using the Ollama $SERVER_VERSION server at $OLLAMA_URL"
else
  OLLAMA_URL="http://127.0.0.1:$OLLAMA_PORT"
  SERVER_VERSION="$(api_version "$OLLAMA_URL")"
  if [ -n "$SERVER_VERSION" ]; then
    [ "$SERVER_VERSION" = "$OLLAMA_VERSION" ] \
      || die "another Ollama ($SERVER_VERSION) is already using port $OLLAMA_PORT; set OLLAMA_PORT to a free port"
    log "Reusing the Ollama $SERVER_VERSION server already running on port $OLLAMA_PORT"
  else
    OLLAMA_BIN=""
    if have ollama && [ "$(ollama_bin_version ollama)" = "$OLLAMA_VERSION" ]; then OLLAMA_BIN="$(command -v ollama)"; fi
    OLLAMA_DIR="$TOOLS/ollama-$OLLAMA_VERSION"
    if [ -z "$OLLAMA_BIN" ] && [ -x "$OLLAMA_DIR/bin/ollama" ]; then OLLAMA_BIN="$OLLAMA_DIR/bin/ollama"; fi
    if [ -z "$OLLAMA_BIN" ]; then
      [ "$OS" = Linux ] || die "install Ollama $OLLAMA_VERSION first (https://ollama.com/download)"
      log "Downloading Ollama $OLLAMA_VERSION for linux-$OLLAMA_ARCH (about 1.4 GB, first run only)"
      download "${OLLAMA_DOWNLOAD_URL:-https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/ollama-linux-$OLLAMA_ARCH.tar.zst}" \
        "$TOOLS/ollama.tar.zst" || die "Ollama download failed (check the internet connection, then run the script again; it resumes)"
      rm -rf "$OLLAMA_DIR.part" && mkdir -p "$OLLAMA_DIR.part"
      if have zstd; then
        zstd -dc "$TOOLS/ollama.tar.zst" | tar -x -C "$OLLAMA_DIR.part"
      else
        python3 -c "$UNZST_PY" "$TOOLS/ollama.tar.zst" "$OLLAMA_DIR.part" "$TOOLS"
      fi || { rm -f "$TOOLS/ollama.tar.zst"; die "could not unpack Ollama; run the script again to download it afresh"; }
      rm -rf "$OLLAMA_DIR" && mv "$OLLAMA_DIR.part" "$OLLAMA_DIR" && rm -f "$TOOLS/ollama.tar.zst"
      OLLAMA_BIN="$OLLAMA_DIR/bin/ollama"
      [ -x "$OLLAMA_BIN" ] || die "the Ollama download did not contain bin/ollama"
    fi
    mkdir -p "$OLLAMA_MODELS_DIR" || die "cannot create $OLLAMA_MODELS_DIR (set OLLAMA_MODELS to a writable folder)"
    log "Starting Ollama $(ollama_bin_version "$OLLAMA_BIN") on port $OLLAMA_PORT, models in $OLLAMA_MODELS_DIR (log: research/ollama_gpu.log)"
    OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" OLLAMA_MODELS="$OLLAMA_MODELS_DIR" OLLAMA_KEEP_ALIVE=2h \
      OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 \
      nohup "$OLLAMA_BIN" serve >> "$ROOT/research/ollama_gpu.log" 2>&1 < /dev/null &
    OLLAMA_PID=$!
    for _ in $(seq 1 60); do
      SERVER_VERSION="$(api_version "$OLLAMA_URL")" && [ -n "$SERVER_VERSION" ] && break
      kill -0 "$OLLAMA_PID" 2>/dev/null || die "Ollama did not start (see research/ollama_gpu.log; port $OLLAMA_PORT taken? set OLLAMA_PORT)"
      sleep 1
    done
    [ -n "$SERVER_VERSION" ] || die "Ollama did not answer within 60 s (see research/ollama_gpu.log)"
  fi
fi
export OLLAMA_BASE_URL="$OLLAMA_URL"

model_digest() { curl -fsS -m 30 "$OLLAMA_URL/api/tags" | python3 -c "$TAGS_PY" "$1"; }

if [ "$MODE" = check ]; then
  for m in "${MODEL_LIST[@]}"; do
    if d="$(model_digest "$m")"; then log "$m is already pulled ($d)"; else log "$m is not pulled yet (about 17 GB)"; fi
  done
  log "Free disk space in $OLLAMA_MODELS_DIR: $(free_gb "$OLLAMA_MODELS_DIR") GB"
  log "Check finished: everything needed is in place. Start the runs with: bash research/run_gpu.sh"
  exit 0
fi

# ---------------------------------------------------------------- 3. runs
run_file() {  # the file evaluate_mimic.ts writes for a model and setup flags
  local m=$1 rag=off safety=off guide="" notice="" a
  shift
  for a in "$@"; do
    case "$a" in
      --rag=on) rag=on ;;
      --safety=on) safety=on ;;
      --guide=on) guide="__guide-on" ;;
      --safety-notice=off) notice="__notice-off" ;;
    esac
  done
  printf '%s/research/results/%s__rag-%s__safety-%s%s%s.json' "$ROOT" "$(slug "$m")" "$rag" "$safety" "$guide" "$notice"
}

# Runs evaluate_mimic.ts in the background and shows its output. If no patient finishes for
# STALL_MINUTES (for example a model that repeats itself without end), the run is stopped
# (exit code 2). Arguments: label, limit ("" for all patients), then evaluate_mimic.ts arguments.
run_eval() {
  local label=$1 limit=$2
  shift 2
  local extra=()
  [ -n "$limit" ] && extra=(--limit="$limit")
  local rlog
  rlog="$RUN_LOGS/$(date +%Y%m%d-%H%M%S)_$(slug "$label").log"
  : > "$rlog"
  (cd "$SERVER" && exec "$TSX" scripts/evaluate_mimic.ts "$@" ${extra[@]+"${extra[@]}"}) > "$rlog" 2>&1 &
  CURRENT_PID=$!
  local shown=0 size last_change rc
  last_change=$(date +%s)
  while kill -0 "$CURRENT_PID" 2>/dev/null; do
    sleep 5
    size=$(wc -c < "$rlog")
    size=$((size))
    if [ "$size" -gt "$shown" ]; then
      tail -c +"$((shown + 1))" "$rlog" | head -c "$((size - shown))"
      shown=$size
      last_change=$(date +%s)
    elif [ $(($(date +%s) - last_change)) -ge $((STALL_MINUTES * 60)) ]; then
      log "!! No patient finished for $STALL_MINUTES minutes: stopping this run."
      kill_tree "$CURRENT_PID"
      wait "$CURRENT_PID" 2>/dev/null
      CURRENT_PID=""
      return 2
    fi
  done
  wait "$CURRENT_PID"
  rc=$?
  CURRENT_PID=""
  size=$(wc -c < "$rlog")
  size=$((size))
  [ "$size" -gt "$shown" ] && tail -c +"$((shown + 1))" "$rlog"
  return $rc
}

PROBLEMS=()
DONE_MODELS=()
INFO_ARGS=()
START_TIME="$(date '+%Y-%m-%d %H:%M:%S %Z')"

for m in "${MODEL_LIST[@]}"; do
  log "=== $m ==="
  if ! digest="$(model_digest "$m")"; then
    free="$(free_gb "$OLLAMA_MODELS_DIR")"
    if [ -n "$free" ] && [ "$free" -lt 20 ]; then
      log "!! Only $free GB free in $OLLAMA_MODELS_DIR, $m needs about 17 GB: skipping it (set OLLAMA_MODELS to a bigger disk)."
      PROBLEMS+=("$m: not enough disk space to pull it")
      continue
    fi
    pulled=""
    for attempt in 1 2 3; do
      log "Pulling $m (attempt $attempt)"
      curl -fsS -N -X POST "$OLLAMA_URL/api/pull" -d "{\"model\": \"$m\"}" | python3 -u -c "$PULL_PY"
      if digest="$(model_digest "$m")"; then pulled=yes; break; fi
      sleep 20
    done
    if [ -z "$pulled" ]; then
      PROBLEMS+=("$m: could not be pulled")
      continue
    fi
  fi
  read -r quant params <<< "$(curl -fsS -m 30 "$OLLAMA_URL/api/show" -d "{\"model\": \"$m\"}" | python3 -c "$SHOW_PY")"
  log "$m: $params parameters, $quant, digest $digest"
  [ "$quant" = "Q4_K_M" ] || log "WARNING: $m is $quant, while the laptop models were Q4_K_M. Report this with the results."

  log "Loading $m on the GPU"
  curl -fsS -m 1800 "$OLLAMA_URL/api/generate" \
    -d "{\"model\": \"$m\", \"prompt\": \"Hello\", \"stream\": false, \"options\": {\"num_ctx\": 8192, \"num_predict\": 1}}" > /dev/null \
    || { PROBLEMS+=("$m: could not be loaded (see research/ollama_gpu.log)"); continue; }
  placement="$(curl -fsS -m 30 "$OLLAMA_URL/api/ps" | python3 -c "$PS_PY" "$m")"
  gpu_rc=$?
  log "$m: $placement"
  if [ "$gpu_rc" -ne 0 ] && [ "$OS" = Linux ] && [ -z "${ALLOW_CPU:-}" ]; then
    if [ "$gpu_rc" -eq 3 ]; then
      log "!! $m does not fit entirely in GPU memory (other jobs on the GPU?). It still runs, more slowly."
    else
      log "!! $m is not on the GPU. Stopping this model; free the GPU or set ALLOW_CPU=1."
      PROBLEMS+=("$m: not loaded on the GPU")
      continue
    fi
  fi

  smoke="$ROOT/research/gpu_smoke/$(slug "$m").json"
  log "$m: smoke test on 2 patients (LLM only)"
  run_eval "$m smoke test" 2 --model="$m" --rag=off --safety=off --out="$smoke" --fresh
  smoke_rc=$?
  smoke_status="$(python3 -c "$STATUS_PY" "$smoke" smoke)"
  smoke_ok=$?
  if [ "$smoke_rc" -ne 0 ] || [ "$smoke_ok" -ne 0 ]; then
    log "!! $m failed the smoke test ($smoke_status): skipping it. The same settings are used for every model,"
    log "!! so a model that cannot answer with them is reported as excluded (as MedGemma 4B was)."
    PROBLEMS+=("$m: failed the smoke test ($smoke_status); log in research/gpu_logs")
    continue
  fi
  log "$m: smoke test passed ($smoke_status)"

  for i in "${!SETUP_FLAGS[@]}"; do
    read -r -a flags <<< "${SETUP_FLAGS[$i]}"
    case "${SETUP_FLAGS[$i]}" in *--rag=on*) flags+=(--retrieval-cache="$CACHE") ;; esac
    name="${SETUP_NAMES[$i]}"
    out="$(run_file "$m" "${flags[@]}")"
    if [ -z "$LIMIT" ] && python3 -c "$STATUS_PY" "$out" > /dev/null 2>&1; then
      log "$m, $name: already finished ($(python3 -c "$STATUS_PY" "$out"))"
      continue
    fi
    log "$m, $name: starting"
    for attempt in 1 2; do
      run_eval "$m $name" "$LIMIT" --model="$m" "${flags[@]}"
      rc=$?
      [ "$rc" -eq 2 ] && break                                        # stuck: do not repeat
      python3 -c "$STATUS_PY" "$out" > /dev/null 2>&1 && break         # finished
      [ "$attempt" -eq 1 ] && log "$m, $name: not finished (exit code $rc), resuming once"
    done
    status="$(python3 -c "$STATUS_PY" "$out")" && ok=yes || ok=""
    log "$m, $name: $status"
    [ -n "$ok" ] || PROBLEMS+=("$m, $name: $status")
  done
  DONE_MODELS+=("$m")
  INFO_ARGS+=("model:$m=digest $digest, $quant, $params")
done

# ---------------------------------------------------------------- 4. summary and results archive
END_TIME="$(date '+%Y-%m-%d %H:%M:%S %Z')"
if [ -z "$LIMIT" ]; then
  log "Summarising with research/analyze.py"
  (cd "$ROOT" && python3 -I research/analyze.py) || log "WARNING: analyze.py failed; the run files are complete anyway, analyse them on the laptop."
fi
GIT_COMMIT="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
problems_arg=()
[ ${#PROBLEMS[@]} -gt 0 ] && problems_arg=("problems=$(printf '%s; ' "${PROBLEMS[@]}")")
python3 -c "$INFO_PY" "$ROOT/research/gpu_run_info.json" \
  "host=$(hostname)" "gpu=$GPU_INFO" "ollama=$SERVER_VERSION" "node=$("$NODE" -v)" "gitCommit=$GIT_COMMIT" \
  "esiGuideSha256=$GUIDE_SHA" "systemPromptSha256=$PROMPT_SHA" "retrievalCacheSha256=$EXPECT_CACHE_SHA256" \
  "started=$START_TIME" "finished=$END_TIME" "limit=${LIMIT:-all 207 patients}" \
  ${INFO_ARGS[@]+"${INFO_ARGS[@]}"} ${problems_arg[@]+"${problems_arg[@]}"}

files=()
for m in ${DONE_MODELS[@]+"${DONE_MODELS[@]}"}; do
  for f in "$ROOT/research/results/$(slug "$m")"__*.json; do [ -f "$f" ] && files+=("research/results/$(basename "$f")"); done
done
ARCHIVE="research/gpu_results_$(date +%Y%m%d-%H%M).tar.gz"
if (cd "$ROOT" && tar -czf "$ARCHIVE" ${files[@]+"${files[@]}"} research/gpu_run_info.json research/run_gpu.log research/gpu_logs); then
  log "Results packed in $ROOT/$ARCHIVE"
else
  log "WARNING: could not pack the results"
fi

if [ ${#PROBLEMS[@]} -eq 0 ]; then
  log "=== All runs finished for: ${MODEL_LIST[*]} ==="
else
  log "=== Finished with problems ==="
  for p in "${PROBLEMS[@]}"; do log "  - $p"; done
fi
log "Copy $ARCHIVE to the laptop (for example with scp) and unpack it in the JeevanSetu folder: tar -xzf $(basename "$ARCHIVE")"
[ ${#PROBLEMS[@]} -eq 0 ]
