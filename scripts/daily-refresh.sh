#!/usr/bin/env bash
#
# daily-refresh.sh — GAZE daily data refresh
#
# Scans session logs + git repos, rebuilds index.html, commits and pushes
# any changes. Designed to run from cron at 4:00 AM daily.
#
# Exit codes:
#   0  success (changes committed + pushed, or no changes found)
#   1  collect.ts failed (non-zero exit)
#   2  build.ts failed (non-zero exit)
#   3  git push failed
#
set -euo pipefail

# --- Environment (cron has a minimal PATH) ---
export PATH="/home/ctodie/.local/bin:/usr/bin:/bin:${PATH:-}"
export HOME="/home/ctodie"

# --- Constants ---
REPO_DIR="/home/ctodie/projects/cerebral/works"
LOG_DIR="${REPO_DIR}/logs"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

cd "${REPO_DIR}"

echo "=========================================="
echo "[${TIMESTAMP}] daily-refresh start"
echo "=========================================="

# --- Step 1: Pull latest remote changes (rebase) ---
echo "--- pulling remote (rebase) ---"
git pull --rebase origin main || {
    echo "WARN: git pull --rebase failed (continuing with local state)"
}

# --- Step 2: Collect data (scans session logs + git repos, ~60s) ---
echo "--- collecting data (bun scripts/collect.ts --fragments) ---"
if ! bun scripts/collect.ts --fragments; then
    echo "ERROR: collect.ts failed"
    echo "[${TIMESTAMP}] daily-refresh: FAILED (collect error)"
    exit 1
fi

# --- Step 3: Rebuild index.html ---
echo "--- building (bun scripts/build.ts) ---"
if ! bun scripts/build.ts; then
    echo "ERROR: build.ts failed"
    echo "[${TIMESTAMP}] daily-refresh: FAILED (build error)"
    exit 2
fi

# --- Step 4: Check for changes ---
echo "--- checking for changes ---"
if git diff --exit-code data.json && git diff --exit-code index.html; then
    echo "no changes detected — nothing to commit"
    echo "[${TIMESTAMP}] daily-refresh: OK (no changes)"
    exit 0
fi

# --- Step 5: Stage, commit, and push ---
echo "--- changes detected, committing ---"
git add data.json index.html

COMMIT_DATE="$(date '+%Y-%m-%d')"
git commit -m "chore: daily data refresh ${COMMIT_DATE}"

echo "--- pushing to origin main ---"
if ! git push origin main; then
    echo "ERROR: git push failed"
    echo "[${TIMESTAMP}] daily-refresh: FAILED (push error)"
    exit 3
fi

echo "[${TIMESTAMP}] daily-refresh: OK (committed and pushed)"
echo "=========================================="
