#!/usr/bin/env bash
# Claim under test: the board this plugin documents, checks and the board plugin
# draws is one format. The board plugin's review view is tested against a fixture
# (board/tests/review-board.example.ts); here that fixture must be the example in
# docs/REVIEW-RULES.md, pass `board.sh check`, and carry exactly the severities the
# check accepts, so neither side can drift without a test failing.
#
# Run: bash test_board_contract.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT/../board/tests/review-board.example.ts"

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
python3 - "$ROOT/docs/REVIEW-RULES.md" "$FIXTURE" "$TD" <<'PY'
import json, re, sys
rules, fixture, out = sys.argv[1:]
doc = json.loads(re.search(r"```json\n(.*?)\n```", open(rules).read(), re.S).group(1))
fx = json.loads(open(fixture).read().split("export const EXAMPLE = ", 1)[1])
json.dump(fx, open(out + "/fixture.json", "w"))
same_top = {k: v for k, v in doc.items() if k != "comments"} == {k: v for k, v in fx.items() if k != "comments"}
print("yes" if same_top and fx["comments"][0] == doc["comments"][0] else "no", file=open(out + "/same", "w"))
print("\n".join(sorted(c["severity"] for c in fx["comments"])), file=open(out + "/severities", "w"))
PY

eq "the board plugin's fixture is the documented example board" "yes" "$(cat "$TD/same")"
eq "the documented example board passes the check" "OK" "$(bash "$SCRIPTS/board.sh" check "$TD/fixture.json")"

accepted="$(grep -o '(\$c\.severity // "") | IN([^)]*)' "$SCRIPTS/board.sh" | grep -o 'IN(.*' | grep -o '"[^"]*"' | tr -d '"' | sort)"
eq "the fixture carries every severity the check accepts, and no other" "$accepted" "$(cat "$TD/severities")"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
