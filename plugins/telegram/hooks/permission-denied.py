#!/usr/bin/env python3
"""Connect Claude Code action review lifecycle events to the Telegram proxy.

The denial remains in force. A later Telegram approval arrives as a new,
action-specific user turn so the normal classifier can review the retry with
explicit consent. This hook never approves or retries a tool call itself.
"""

from __future__ import annotations

import json
import os
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen

RUNTIME_CONTEXT = (
    "SYSTEM RUNTIME POLICY: Auto mode may deny a tool action. The Telegram bridge "
    "offers that exact action to the operator. Do not suggest SSH, /permissions, or "
    "a classifier workaround. When a later user turn explicitly approves an exact "
    "action once, retry only that action and let the normal auto-mode reviewer "
    "evaluate it again. If crash recovery repeats the same authorization request "
    "ID, do not retry it twice. Never broaden, split, encode, or otherwise disguise it."
)


def main() -> int:
    try:
        event = json.load(sys.stdin)
        event_name = event.get("hook_event_name")
        if event_name == "SessionStart":
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": RUNTIME_CONTEXT,
                }
            }))
            return 0
        if event_name != "PermissionDenied":
            return 0
        topic = os.environ.get("TELEGRAM_TOPIC_ID", "").strip()
        proxy = os.environ.get("TELEGRAM_PROXY_URL", "").rstrip("/")
        if not topic or not proxy:
            return 0
        payload = dict(event)
        payload["topic"] = topic
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{proxy}/permission-denied",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=5) as response:
            response.read()
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        # Fail open: the original Claude Code denial still stands. Hook
        # transport trouble must not crash or alter the agent turn.
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
