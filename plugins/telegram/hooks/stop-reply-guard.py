#!/usr/bin/env python3
"""Stop hook for the Telegram channel: keep replies out of the transcript.

When Claude finishes a turn that was triggered by an inbound Telegram <channel>
message but never called the reply tool, its answer is stranded in the
transcript - the Telegram user never sees it (the classic "you there?" failure).
This blocks the stop with a short reminder so Claude re-sends via the reply tool.
It reminds at MOST once per turn (loop guard: `stop_hook_active` and a marker it
leaves in its own reason), then lets the stop through.

Wired in two places (same script):
- the telegram-topics plugin's hooks/hooks.json (auto-applies to topic-Claudes)
- the single-session bridge's --settings override (references this script)

Stop-hook contract: reads a JSON object on stdin (with `transcript_path` and
`stop_hook_active`); to BLOCK the stop it prints
`{"decision":"block","reason":"..."}` on stdout, which Claude sees as feedback
and acts on. Any other exit (0, no output) lets the stop proceed.
"""
import json
import os
import sys

GUARD_MARKER = "TELEGRAM-REPLY-GUARD"  # in our reason; lets us detect our own reminder
CHANNEL_MARKER = 'source="plugin:telegram:telegram"'
REPLY_TOOL = "mcp__plugin_telegram_telegram__reply"
TAIL_BYTES = 2_000_000  # last ~2MB of the transcript covers the current turn; fail-open past that
LOG = os.path.expanduser("~/Library/Logs/telegram-reply-guard.log")


def log(msg: str) -> None:
    try:
        with open(LOG, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def read_tail(path: str):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > TAIL_BYTES:
            f.seek(size - TAIL_BYTES)
            f.readline()  # discard the partial first line
        data = f.read()
    out = []
    for raw in data.decode("utf-8", "replace").splitlines():
        raw = raw.strip()
        if raw:
            try:
                out.append(json.loads(raw))
            except Exception:
                pass
    return out


def content_of(o):
    return (o.get("message") or {}).get("content")


def main() -> None:
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return
    # Already reminded once this stop-cycle -> let it stop (no loop).
    if hook.get("stop_hook_active"):
        return
    path = hook.get("transcript_path")
    if not path or not os.path.exists(path):
        return
    try:
        entries = read_tail(path)
    except Exception:
        return

    # Index of the LAST inbound Telegram <channel> message (a string user turn).
    last_ch = -1
    last_blob = ""
    for i, o in enumerate(entries):
        if o.get("type") != "user":
            continue
        c = content_of(o)
        blob = c if isinstance(c, str) else json.dumps(c or "")
        if CHANNEL_MARKER in blob:
            last_ch = i
            last_blob = blob
    if last_ch < 0:
        return  # this turn was not triggered by a Telegram message

    # SQUARE turns (meta square="1"): silence is sanctioned - the norm is
    # "reply only if it moves the work forward; if no reply is warranted, do
    # nothing" - so we never nag for a missing reply. But the OPPOSITE failure
    # is real (observed 2026-07-17): a long-lived resumed session answers a
    # square message via the generic reply tool out of habit, posting into its
    # OWN topic (the wrong room). Catch exactly that: replied-with-reply but
    # not square_reply -> one corrective block.
    if 'square="1"' in last_blob:
        used_reply = used_square = False
        for o in entries[last_ch:]:
            c = content_of(o)
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        if b.get("name") == REPLY_TOOL:
                            used_reply = True
                        if b.get("name", "").endswith("square_reply"):
                            used_square = True
        if used_reply and not used_square and not any(
            GUARD_MARKER in json.dumps(o) for o in entries[last_ch:]
        ):
            log("blocking stop: square turn answered via the reply tool (wrong room)")
            print(json.dumps({
                "decision": "block",
                "reason": (
                    "REPLY-GUARD: this turn was a #square message (square=\"1\" in its meta), but you "
                    "answered with the generic reply tool - that posted into YOUR OWN topic, which the "
                    "square conversation participants cannot see. Re-send your answer NOW via the "
                    "square_reply tool using the conv and reply_token from the square message's meta/norm "
                    "line, and note that the message in your own topic was misdirected."
                ),
            }))
        return

    # Since then: did we already reply, or already remind (our marker)?
    replied = reminded = False
    for o in entries[last_ch:]:
        c = content_of(o)
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == REPLY_TOOL:
                    replied = True
        if GUARD_MARKER in json.dumps(o):
            reminded = True
    if replied or reminded:
        return

    log(f"blocking stop: telegram turn ended without a reply (session {hook.get('session_id','?')})")
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"[{GUARD_MARKER}] Your response went to the transcript, which the Telegram user "
            f"cannot see. Send it to them NOW via the {REPLY_TOOL} tool (use the chat_id from "
            "the inbound <channel> block). Do not just write the reply as plain text."
        ),
    }))


if __name__ == "__main__":
    main()
