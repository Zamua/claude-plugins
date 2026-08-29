#!/usr/bin/env python3
"""StopFailure hook: report a usage-limit stall to the topic proxy.

Claude Code's built-in fallback chain handles model availability, not plan
quota. A plan limit therefore stalls an interactive session until its route is
changed. This hook is the tripwire that lets the proxy surface a provider/model
picker in Telegram while keeping the same Claude Code session UUID.

StopFailure fires when a turn ends on an API error, with error == "rate_limit"
for a 429. It is notification-only, so it tells the proxy, which owns the
session lifecycle and pauses the exhausted route until the operator selects
another provider/model.

Fires and forgets: any failure here is swallowed, because a hook that throws
must never make a already-failing turn worse.
"""

# macOS ships python3.9 as /usr/bin/python3 and that is what the hook
# command resolves to, so `int | None` / `list[int]` annotations would blow up
# at runtime (they are evaluated at def time) exactly when a rate limit hits.
# This makes every annotation lazy, keeping the hook 3.7+ safe.
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

LOG = os.path.expanduser("~/Library/Logs/telegram-rate-limit-failover.log")


def log(msg: str) -> None:
    try:
        with open(LOG, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def parse_reset(details: str) -> int | None:
    """Best-effort: pull a quota-reset time out of a rate-limit error message.

    Claude's limit errors have carried the reset moment in several shapes over
    time (a `|<unix>` suffix, a `resets at <ISO>` phrase, a bare epoch). Rather
    than depend on one format, accept any of them and sanity-check the result:
    a reset must be in the future and within a week, so a random number in the
    message text cannot schedule a bogus reset notification a month out.
    """
    now = int(time.time())
    horizon = now + 7 * 24 * 3600
    candidates: list[int] = []

    for m in re.finditer(r"\b(\d{10})\b", details):  # bare unix seconds
        candidates.append(int(m.group(1)))
    for m in re.finditer(r"\b(\d{13})\b", details):  # unix millis
        candidates.append(int(m.group(1)) // 1000)
    for m in re.finditer(r"(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)", details):
        try:
            candidates.append(int(datetime.fromisoformat(m.group(1)).timestamp()))
        except ValueError:
            pass

    future = [c for c in candidates if now < c <= horizon]
    return min(future) if future else None


def main() -> None:
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return

    topic = os.environ.get("TELEGRAM_TOPIC_ID")
    proxy = os.environ.get("TELEGRAM_PROXY_URL")
    err = str(hook.get("error", "unknown"))
    if not topic or not proxy:
        log("StopFailure (%s) but no topic/proxy env (topic=%r)" % (err, topic))
        return

    details = str(hook.get("error_details", ""))[:500]

    # rate_limit -> the provider-picker flow below. EVERYTHING ELSE (overloaded/529,
    # 5xx, auth, ...) -> tell the operator in this topic's thread: the failed
    # turn already swallowed their message, and without a notice the session
    # just looks like it ignored them (observed with silent 529s, 2026-07-29).
    # Model-switching would not fix these, so notify-only.
    if err != "rate_limit":
        payload = json.dumps({"topic": topic, "error": err, "details": details}).encode()
        req = urllib.request.Request(
            proxy + "/turn-failed", data=payload,
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                # log the detail text too - without it, diagnosing WHY a turn
                # failed means digging through session transcripts.
                log("reported %s for topic %s: %s | %s"
                    % (err, topic, res.status, details[:160].replace("\n", " ")))
        except Exception as e:
            log("failed reporting %s for topic %s: %s" % (err, topic, e))
        return
    payload = json.dumps(
        {
            "topic": topic,
            "error": hook.get("error"),
            "details": details,
            # Opportunistic: the limit error often carries WHEN the quota
            # resets. Pass it along so the proxy can notify the operator at
            # the right time. Absent/garbled means provider probes remain the
            # source of truth, so this is an optimization, never a dependency.
            **({"reset_at": r} if (r := parse_reset(details)) else {}),
        }
    ).encode()
    req = urllib.request.Request(
        f"{proxy}/rate-limit",
        data=payload,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            log(f"reported rate_limit for topic {topic}: {res.status} {res.read()[:200]!r}")
    except Exception as e:
        log(f"failed reporting rate_limit for topic {topic}: {e}")


if __name__ == "__main__":
    main()
