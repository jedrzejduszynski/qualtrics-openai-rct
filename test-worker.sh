#!/usr/bin/env bash
set -euo pipefail

WORKER_BASE_URL="${WORKER_BASE_URL:-https://REPLACE-WITH-YOUR-WORKER.workers.dev}"
STUDY_KEY="${STUDY_KEY:-REPLACE_WITH_QUALTRICS_SESSION_KEY}"
PAGES_ORIGIN="${PAGES_ORIGIN:-https://REPLACE-WITH-YOUR-PAGES-SITE.pages.dev}"
PARTICIPANT_ID="${PARTICIPANT_ID:-test-participant-001}"
ARM="${ARM:-socratic}"

echo "1. Health check"
curl -fsS "$WORKER_BASE_URL/health" | python3 -m json.tool

echo
echo "2. Create signed session"
SESSION_JSON=$(curl -fsS "$WORKER_BASE_URL/session" \
  -H "X-Study-Key: $STUDY_KEY" \
  -H "Content-Type: application/json" \
  --data "{\"participant_id\":\"$PARTICIPANT_ID\",\"arm\":\"$ARM\"}")
echo "$SESSION_JSON" | python3 -m json.tool
TOKEN=$(printf '%s' "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_token"])')

echo
echo "3. Send chat request"
curl -fsS "$WORKER_BASE_URL/chat" \
  -H "Origin: $PAGES_ORIGIN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"task_id":"main","messages":[{"role":"user","content":"Help me think through an original campaign idea for a reusable bottle."}]}' \
  | python3 -m json.tool
