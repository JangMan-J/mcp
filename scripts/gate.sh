#!/usr/bin/env bash
# npm run gate — spec gate entrypoint (IMPLEMENTATION_PLAN.md section 14.2).
#
# Stages:
#   1. prereq (dev toolchain): export HEAD into a scratch tree, `npm ci` with dev
#      deps, build every workspace (needs TypeScript), and run the remove:ext-*
#      checks (they rebuild with tsc). Results land in $GATE_PREREQ_DIR; nothing
#      from this tree's node_modules reaches the production runtime.
#   2. prod: export HEAD again, copy only built dist/ output in, `npm ci --omit=dev`.
#   3. run: assert-no-pi + packages/conformance/dist/gate.js in a fresh session
#      (setsid) with `env -i`: temp HOME, no XDG_*, PI_*, NODE_PATH, NODE_OPTIONS.
# Reports go to $GATE_REPORTS_DIR (default <checkout>/reports); GATE_SHA is the
# original checkout's HEAD. No npx/implicit runner download: npm runs offline
# inside the gate process and the official runner must already be cached.
set -euo pipefail

# Scrub inherited environment before anything else runs.
while IFS= read -r name; do
  case "$name" in PI_*|XDG_*) unset "$name" ;; esac
done < <(compgen -e)
unset NODE_PATH NODE_OPTIONS

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
GATE_REPORTS_DIR="${GATE_REPORTS_DIR:-$ROOT/reports}"
mkdir -p "$GATE_REPORTS_DIR"
GATE_REPORTS_DIR="$(cd "$GATE_REPORTS_DIR" && pwd)"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "gate: warning: checkout has uncommitted changes; gating committed HEAD $GATE_SHA" >&2
fi

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
# Reuse the caller's npm cache for installs so a fresh HOME does not force downloads.
NPM_CACHE="$(npm config get cache 2>/dev/null || true)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-gate-XXXXXX")"
DEV="$WORK/dev"
PROD="$WORK/prod"
GATE_HOME="$WORK/home"
GATE_TMP="$WORK/tmp"
GATE_PREREQ_DIR="$GATE_REPORTS_DIR/prereq-$GATE_SHA"
mkdir -p "$DEV" "$PROD" "$GATE_HOME" "$GATE_TMP"
rm -rf "$GATE_PREREQ_DIR"
mkdir -p "$GATE_PREREQ_DIR"

child=""
cleanup() {
  local rc=$?
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM -- "-$child" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$child" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE_PATH="$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN"):/usr/bin:/bin"

# Run a command in a new session (fresh process group) with a minimal, scrubbed
# environment. Usage: isolated <cwd> <logfile|-> [NAME=VALUE...] -- cmd args...
# The child's pid is tracked so cleanup can kill its whole process group.
isolated() {
  local dir="$1" log="$2"; shift 2
  local -a vars=(HOME="$GATE_HOME" TMPDIR="$GATE_TMP" PATH="$BASE_PATH" LANG=C.UTF-8
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
    COREPACK_ENABLE_NETWORK=0)
  [ -n "$NPM_CACHE" ] && vars+=(npm_config_cache="$NPM_CACHE")
  while [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  if [ "$log" = "-" ]; then
    setsid env -i -C "$dir" "${vars[@]}" "$@" &
  else
    setsid env -i -C "$dir" "${vars[@]}" "$@" >"$log" 2>&1 &
  fi
  child=$!
  local rc=0
  wait "$child" || rc=$?
  child=""
  return "$rc"
}

export_head() { git -C "$ROOT" archive --format=tar "$GATE_SHA" | tar -x -C "$1"; }

echo "gate: sha $GATE_SHA, work $WORK, reports $GATE_REPORTS_DIR"

# --- 1. prereq stage (dev toolchain, outside production runtime) ---
export_head "$DEV"
isolated "$DEV" "$GATE_PREREQ_DIR/npm-ci-dev.log" -- "$NPM_BIN" ci --prefer-offline --ignore-scripts \
  || { echo "gate: dev npm ci failed (see $GATE_PREREQ_DIR/npm-ci-dev.log)" >&2; exit 1; }
isolated "$DEV" "$GATE_PREREQ_DIR/build.log" -- "$NODE_BIN" scripts/build-workspaces.mjs \
  || { echo "gate: build failed (see $GATE_PREREQ_DIR/build.log)" >&2; exit 1; }

remove_json="$GATE_PREREQ_DIR/remove-ext.json"
printf '[' >"$remove_json"
sep=""
for script in $(cd "$DEV" && "$NODE_BIN" -e 'for (const k of Object.keys(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts)) if (k.startsWith("remove:")) console.log(k)'); do
  ext="${script#remove:}"
  log="$GATE_PREREQ_DIR/$ext.log"
  rc=0
  isolated "$DEV" "$log" -- "$NODE_BIN" scripts/check-remove-ext.mjs "$ext" || rc=$?
  printf '%s{"script":"%s","ext":"%s","exitCode":%d,"log":"%s"}' "$sep" "$script" "$ext" "$rc" "$ext.log" >>"$remove_json"
  sep=","
  echo "gate: prereq $script exit $rc"
done
printf ']\n' >>"$remove_json"

# --- 2. production runtime tree: built output + production-only deps ---
export_head "$PROD"
for d in "$DEV"/packages/*/dist; do
  pkg="$(basename "$(dirname "$d")")"
  cp -R "$d" "$PROD/packages/$pkg/dist"
done
isolated "$PROD" "$GATE_PREREQ_DIR/npm-ci-prod.log" -- "$NPM_BIN" ci --omit=dev --prefer-offline --ignore-scripts \
  || { echo "gate: production npm ci failed (see $GATE_PREREQ_DIR/npm-ci-prod.log)" >&2; exit 1; }
rm -rf "$DEV"

GATE_JS="$PROD/packages/conformance/dist/gate.js"
if [ ! -f "$GATE_JS" ]; then
  echo "gate: missing built $GATE_JS" >&2
  exit 1
fi

# --- 3. run the gate from built output in a fresh process tree ---
gate_env=(
  GATE_SHA="$GATE_SHA"
  GATE_REPORTS_DIR="$GATE_REPORTS_DIR"
  GATE_PREREQ_DIR="$GATE_PREREQ_DIR"
  GATE_CHECKOUT="$ROOT"
  GATE_RUNTIME_ROOT="$PROD"
  GATE_NO_DOWNLOAD=1
  npm_config_offline=true
)
isolated "$PROD" - "${gate_env[@]}" -- "$NODE_BIN" scripts/assert-no-pi.mjs
isolated "$PROD" - "${gate_env[@]}" -- "$NODE_BIN" "$GATE_JS" "$@"
