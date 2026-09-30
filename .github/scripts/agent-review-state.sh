#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

MAX_REMEDIATION_PASSES="${MAX_REMEDIATION_PASSES:-3}"
STATE_MARKER='<!-- agent-review-state -->'

find_state_comment_id() {
  gh api --paginate "repos/$REPO/issues/$PR_NUMBER/comments"     --jq ".[] | select(.body | contains(\"$STATE_MARKER\")) | .id"     | tail -n 1
}

read_state_body() {
  local id
  id="$(find_state_comment_id)"
  if [ -n "$id" ]; then
    gh api "repos/$REPO/issues/comments/$id" --jq '.body'
  fi
}

state_get() {
  local id body passes final
  id="$(find_state_comment_id)"
  if [ -z "$id" ]; then
    echo "comment_id="
    echo "passes=0"
    echo "final=not_started"
    exit 0
  fi

  body="$(gh api "repos/$REPO/issues/comments/$id" --jq '.body')"
  passes="$(sed -n 's/^<!-- passes=\([0-9][0-9]*\) -->$/\1/p' <<<"$body" | head -n 1)"
  final="$(sed -n 's/^<!-- final=\([^ ]*\) -->$/\1/p' <<<"$body" | head -n 1)"

  echo "comment_id=$id"
  echo "passes=${passes:-0}"
  echo "final=${final:-not_started}"
}

final_label() {
  case "$1" in
    not_started) echo "Not started" ;;
    running) echo "Running" ;;
    complete) echo "Complete" ;;
    blocked) echo "Blocked" ;;
    *) echo "$1" ;;
  esac
}

state_set() {
  local passes="${PASSES:-0}"
  local final="${FINAL:-not_started}"
  local stage="${STAGE:-Unknown}"
  local details="${DETAILS:-}"
  local id label body

  id="$(find_state_comment_id)"
  label="$(final_label "$final")"

  body="$STATE_MARKER
<!-- passes=$passes -->
<!-- final=$final -->
### Agent review status

**Stage:** $stage
**Automated remediation:** $passes / $MAX_REMEDIATION_PASSES
**Final audit:** $label"

  if [ -n "$details" ]; then
    body="$body

$details"
  fi

  if [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -f body="$body" >/dev/null
  else
    id="$(gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$body" --jq '.id')"
  fi

  echo "comment_id=$id"
}

count_codex_reviews() {
  gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews"     --jq '.[] | select(.user.login | startswith("chatgpt-codex-connector")) | .id'     | wc -l     | tr -d ' '
}

request_codex() {
  local origin="${1:-remediation}"
  local baseline request_comment_id body

  baseline="$(count_codex_reviews)"
  body="@codex review
<!-- agent-review-request origin=$origin -->"
  request_comment_id="$(
    gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$body" --jq '.id'
  )"

  echo "request_comment_id=$request_comment_id"
  echo "baseline=$baseline"
}

latest_request_origin() {
  local body origin
  body="$(
    gh api --paginate "repos/$REPO/issues/$PR_NUMBER/comments"       --jq '.[] | select(.body | startswith("@codex review")) | .body'       | tail -n 1
  )"

  origin="$(sed -n 's/^<!-- agent-review-request origin=\([^ ]*\) -->$/\1/p' <<<"$body" | tail -n 1)"
  echo "${origin:-manual}"
}

wait_codex() {
  local request_comment_id="${1:?request comment id required}"
  local baseline="${2:?baseline review count required}"
  local timeout_seconds="${CODEX_WAIT_SECONDS:-900}"
  local poll_seconds="${CODEX_POLL_SECONDS:-15}"
  local heartbeat_seconds="${CODEX_HEARTBEAT_SECONDS:-30}"
  local started="$SECONDS"
  local last_heartbeat=-999
  local current elapsed clean_reaction clean_comment

  while [ $((SECONDS - started)) -lt "$timeout_seconds" ]; do
    current="$(count_codex_reviews)"
    if [ "$current" -gt "$baseline" ]; then
      echo "findings"
      return 0
    fi

    clean_reaction="$(
      gh api --paginate         -H "Accept: application/vnd.github+json"         "repos/$REPO/issues/comments/$request_comment_id/reactions"         --jq '.[] | select((.user.login | startswith("chatgpt-codex-connector")) and .content == "+1") | .id'         | head -n 1
    )"

    clean_comment="$(
      gh api --paginate "repos/$REPO/issues/$PR_NUMBER/comments"         | jq -r --argjson request "$request_comment_id"           '.[] | select(.id > $request) | select(.user.login | startswith("chatgpt-codex-connector")) | select(.body | contains("find any major issues")) | .id'         | head -n 1
    )"

    if [ -n "$clean_reaction" ] || [ -n "$clean_comment" ]; then
      echo "clean"
      return 0
    fi

    elapsed=$((SECONDS - started))
    if [ $((elapsed - last_heartbeat)) -ge "$heartbeat_seconds" ]; then
      echo "Codex review still running: elapsed ${elapsed}s, review count $current (baseline $baseline)." >&2
      last_heartbeat="$elapsed"
    fi

    sleep "$poll_seconds"
  done

  echo "pending"
}

resolve_codex_threads() {
  local owner name thread_ids
  owner="${REPO%%/*}"
  name="${REPO#*/}"

  thread_ids="$(
    gh api graphql       -f owner="$owner"       -f name="$name"       -F number="$PR_NUMBER"       -f query='
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 20) {
                    nodes {
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }'       --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved == false)
        | select(any(.comments.nodes[]; ((.author.login // "") | startswith("chatgpt-codex-connector"))))
        | .id'
  )"

  if [ -z "$thread_ids" ]; then
    echo "No unresolved Codex review threads to resolve."
    return 0
  fi

  while IFS= read -r thread_id; do
    [ -n "$thread_id" ] || continue
    gh api graphql       -f id="$thread_id"       -f query='
        mutation($id: ID!) {
          resolveReviewThread(input: {threadId: $id}) {
            thread { id isResolved }
          }
        }'       >/dev/null
    echo "Resolved Codex review thread $thread_id"
  done <<<"$thread_ids"
}

case "${1:-}" in
  get)
    state_get
    ;;
  set)
    state_set
    ;;
  request)
    request_codex "${2:-remediation}"
    ;;
  latest-origin)
    latest_request_origin
    ;;
  wait)
    wait_codex "${2:-}" "${3:-}"
    ;;
  resolve-threads)
    resolve_codex_threads
    ;;
  *)
    echo "Usage: $0 {get|set|request <origin>|latest-origin|wait <request-comment-id> <baseline>|resolve-threads}" >&2
    exit 2
    ;;
esac
