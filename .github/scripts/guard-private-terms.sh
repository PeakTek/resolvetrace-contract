#!/usr/bin/env bash
#
# CI guard: block private-repo / managed-service references from entering this
# PUBLIC repository — in commit messages, the PR title/body, or newly-added
# source lines.
#
# The denylist of sensitive terms is deliberately NOT stored in this (public)
# repo. It is provided at runtime via the PRIVATE_TERM_DENYLIST_B64 environment
# variable, sourced from a GitHub Actions secret. Matches are reported by line
# number only — the matched text is never printed, so this (public) CI log can
# never echo a sensitive term.
#
# Usage: PRIVATE_TERM_DENYLIST_B64=<base64> [PR_TITLE=..] [PR_BODY=..] \
#          guard-private-terms.sh <base-ref>
#
set -uo pipefail

BASE_REF="${1:-origin/main}"
HEAD_REF="${2:-HEAD}"

if [ -z "${PRIVATE_TERM_DENYLIST_B64:-}" ]; then
  echo "::warning::PRIVATE_TERM_DENYLIST_B64 not set — skipping guard (expected on fork / dependabot PRs that cannot read secrets)."
  exit 0
fi

# Patterns: one POSIX extended-regex per line. Decoded into memory; never echoed.
PATTERNS="$(printf '%s' "$PRIVATE_TERM_DENYLIST_B64" | base64 --decode 2>/dev/null || true)"
if [ -z "$PATTERNS" ]; then
  echo "::error::Could not decode PRIVATE_TERM_DENYLIST_B64 (expected base64 of newline-separated regexes)."
  exit 2
fi

fail=0

# Report matches by line number only; never print the offending text.
# Called directly (NOT via a pipe) so that `fail` persists in this shell.
scan() {
  local label="$1" text="$2" nums
  [ -z "$text" ] && return 0
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    nums="$(printf '%s\n' "$text" | grep -niE -- "$pat" 2>/dev/null | cut -d: -f1 | paste -sd, -)"
    if [ -n "$nums" ]; then
      echo "::error::$label matched the private-term denylist at line(s): $nums. Reframe using only the public contract / composition seam; do not name private repos or components."
      fail=1
    fi
  done <<EOF
$PATTERNS
EOF
}

# 1) Commit messages introduced by this PR.
commits="$(git log --no-merges --format='%H%n%B' "${BASE_REF}..${HEAD_REF}" 2>/dev/null || true)"
scan "A commit message in this PR" "$commits"

# 2) PR title + body (passed via env from the event payload — never interpolated).
scan "The PR title/body" "$(printf '%s\n%s\n' "${PR_TITLE:-}" "${PR_BODY:-}")"

# 3) Newly-added source lines only (pre-existing lines are not re-scanned).
added="$(git diff --no-color "${BASE_REF}...${HEAD_REF}" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | sed -E 's/^\+//' || true)"
scan "A newly-added source line" "$added"

if [ "$fail" -ne 0 ]; then
  echo "::error::Private-term guard failed. Policy: this is a public repository; describe behavior via the public contract/seam only and never reference private repos, components, or internal decision records."
  exit 1
fi
echo "Private-term guard passed — no private / managed-service references found."
