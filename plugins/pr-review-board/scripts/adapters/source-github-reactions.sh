#!/usr/bin/env bash
# pr-review-board source adapter: GitHub reactions, via `gh api graphql`.
# The trigger is a reaction YOU added to a pull request body, recently.
#
# Contract used by poll.sh:
#   src_deps
#   src_me                     -> the viewer's login
#   src_cutoff_iso             -> only reactions at or after this instant count
#   src_fresh                  -> TSV of freshly-reacted PRs (see FIELDS below)
#   src_pr_meta <pr>           -> TSV row for one PR, for reconcile paths
#   src_kickoff_context <key>  -> the worker's opening brief
#
# Why a freshness window rather than a stored watermark: the reaction carries its
# own createdAt, so "did I just ask for this" is a property of the trigger itself.
# Historical reactions can never spawn, no bookkeeping required.
#
# There is no reverse lookup for "things the viewer reacted to" in either the REST
# or GraphQL API, so eligibility is a candidate scan plus a per-candidate check.
# `reactions:>0` narrows the candidate set server-side and `viewerHasReacted` is
# evaluated for us, which keeps the whole pass at 1 rate-limit point per page.
# Filtering on the viewer matters because bots react to pull requests constantly.

FIELDS='pr reactedAt head base defaultBranch isDraft title url'

src_deps() { printf 'gh jq'; }

_src_me_cache=""
src_me() {
  [ -n "$_src_me_cache" ] && { printf '%s' "$_src_me_cache"; return; }
  local v; v="$(prb_get gh_login "")"
  [ -n "$v" ] || v="$(gh api user --jq '.login' 2>/dev/null)"
  _src_me_cache="$v"; printf '%s' "$v"
}

# The search scope. Repeated `org:` qualifiers are OR'd by GitHub search, so a
# multi-org config is still one query. Unscoped would match all of public GitHub.
#
# Closed and merged pull requests stay in scope so a post-hoc review of something
# already landed still works. That costs nothing today: the whole org fits in one
# 100-node page either way. Narrow it with `search_extra` (e.g. "is:open").
_src_query() {
  local q='is:pr reactions:>0' o extra any=0
  while IFS= read -r o; do
    [ -n "$o" ] || continue
    q="$q org:$o"; any=1
  done < <(prb_get_list orgs)
  [ "$any" = 1 ] || { prb_log "config 'orgs' is empty; refusing an unscoped GitHub search"; return 1; }
  extra="$(prb_get search_extra "")"
  [ -n "$extra" ] && q="$q $extra"
  printf '%s' "$q"
}

# cutoff = min(now - window, last_poll)
#
# Equivalently the window is max(configured, time since the last successful pass),
# so a laptop that slept through a reaction still catches it on wake instead of
# dropping it silently. Historical reactions stay excluded either way, because a
# successful pass was recorded long after they were added. With no recorded pass
# (fresh install) it falls back to the flat window, so day one ignores all history.
src_cutoff_iso() {
  local now win last cutoff
  now="$(date -u +%s)"
  win="$(prb_get spawn_window_seconds 600)"
  last="$(prb_last_poll)"; [ -n "$last" ] || last=0
  cutoff=$(( now - win ))
  if [ "$last" -gt 0 ] && [ "$last" -lt "$cutoff" ]; then cutoff="$last"; fi
  date -u -r "$cutoff" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$cutoff" +%Y-%m-%dT%H:%M:%SZ
}

_src_gql() {
  cat <<'GQL'
query($q: String!, $content: ReactionContent!, $cursor: String) {
  rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        baseRefName
        headRefName
        repository { nameWithOwner defaultBranchRef { name } }
        reactions(content: $content, first: 50) {
          nodes { createdAt user { login } }
        }
      }
    }
  }
}
GQL
}

# One TSV row per PR the viewer reacted to at/after the cutoff. Paginates, because
# a busy org can exceed one page of candidates.
src_fresh() {
  local q me cutoff content cursor="" page=0 out
  q="$(_src_query)" || return 1
  me="$(src_me)"; [ -n "$me" ] || { prb_log "cannot resolve the viewer's login (gh auth?)"; return 1; }
  cutoff="$(src_cutoff_iso)"
  content="$(prb_get reaction EYES)"
  prb_log "scan: '$q' reaction=$content viewer=$me cutoff=$cutoff"
  while :; do
    page=$(( page + 1 ))
    if [ -n "$cursor" ]; then
      out="$(gh api graphql -f query="$(_src_gql)" -F q="$q" -f content="$content" -F cursor="$cursor" 2>&1)"
    else
      out="$(gh api graphql -f query="$(_src_gql)" -F q="$q" -f content="$content" 2>&1)"
    fi
    printf '%s' "$out" | jq -e '.data.search' >/dev/null 2>&1 || {
      prb_log "GraphQL scan failed on page $page: $(printf '%s' "$out" | head -c 400)"; return 1; }
    printf '%s' "$out" | jq -r --arg me "$me" --arg cutoff "$cutoff" '
      .data.search.nodes[]
      | select(.number)
      | . as $p
      | [ .reactions.nodes[]? | select(.user.login == $me and .createdAt >= $cutoff) ]
      | if length == 0 then empty else
          ( map(.createdAt) | max ) as $at
          | [ "\($p.repository.nameWithOwner)#\($p.number)",
              $at,
              $p.headRefName,
              $p.baseRefName,
              ($p.repository.defaultBranchRef.name // "main"),
              ($p.isDraft|tostring),
              ($p.title | gsub("[\t\n\r]"; " ")),
              $p.url ]
            | @tsv
        end'
    [ "$page" -lt 3 ] || prb_log "candidate scan is on page $page; consider narrowing with search_extra"
    [ "$(printf '%s' "$out" | jq -r '.data.search.pageInfo.hasNextPage')" = "true" ] || break
    cursor="$(printf '%s' "$out" | jq -r '.data.search.pageInfo.endCursor')"
    [ -n "$cursor" ] && [ "$cursor" != "null" ] || break
  done
}

# One PR by name, for paths that need its metadata without a scan. Emits the same
# row shape as src_fresh.
#
# Every field must be NON-EMPTY. A tab is IFS-whitespace, so `IFS=$'\t' read`
# collapses consecutive tabs and silently drops empty fields, shifting every later
# field left. Emitting a placeholder-free complete row is the fix; do not reintroduce
# an empty column here.
src_pr_meta() {  # <owner/repo#N>
  local pr repo num owner name
  pr="$1"; repo="${pr%%#*}"; num="${pr##*#}"
  owner="${repo%%/*}"; name="${repo##*/}"
  gh api graphql -f query='
    query($owner:String!,$name:String!,$num:Int!){
      repository(owner:$owner,name:$name){
        defaultBranchRef { name }
        pullRequest(number:$num){
          number title url isDraft baseRefName headRefName
        }
      }
    }' -F owner="$owner" -F name="$name" -F num="$num" 2>/dev/null \
    | jq -r --arg pr "$pr" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        .data.repository as $r
        | $r.pullRequest
        | select(. != null)
        | [ $pr, $now, .headRefName, .baseRefName,
            ($r.defaultBranchRef.name // "main"), (.isDraft|tostring),
            ((.title // "untitled") | gsub("[\t\n\r]"; " ")),
            .url ] | @tsv'
}

# The worker's opening brief. Deliberately short: the assignment file in the review
# dir is the contract, and the persona carries the process.
src_kickoff_context() {  # <review-key>
  local key="$1" slug
  slug="$(prb_review_field "$key" slug)"
  printf 'Review request %s (key %s). Your assignment file is %s/assignment.json and it lists every pull request in scope. Read it first, then follow your review protocol end to end. This review is read-only on GitHub: no comments, no reviews, no approvals, no pushes.' \
    "$slug" "$key" "$(prb_meta_dir "$key")"
}
