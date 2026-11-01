# A stand-in `gh` for the tests, so none of them reach GitHub. Source this file, then
# `fake_gh <dir>` makes <dir> HOME and puts the fake in $HOME/.local/bin, the first
# place lib.sh's PATH looks, so it wins in every script the test runs. It answers
# from files in <dir>:
#   graphql.json   any `gh api graphql` query
#   diff           `gh pr diff` (absent: the call fails, as for a pull request GitHub lacks)
# `gh api user` answers "operator", and `gh pr list` finds no other open pull request.
# Every call is appended to <dir>/gh.calls.
fake_gh() {  # <dir>
  mkdir -p "$1/.local/bin"
  cat > "$1/.local/bin/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$1/gh.calls"
case "\$1 \$2" in
  "api graphql") cat "$1/graphql.json" ;;
  "api user") echo operator ;;
  "pr list") ;;
  "pr diff") cat "$1/diff" 2>/dev/null ;;
  *) echo "fake gh: unexpected call: \$*" >&2; exit 1 ;;
esac
SH
  chmod +x "$1/.local/bin/gh"
  export HOME="$1"
  PATH="$1/.local/bin:$PATH"
}
