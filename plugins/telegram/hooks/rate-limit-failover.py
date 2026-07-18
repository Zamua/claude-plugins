#!/usr/bin/env python3
"""StopFailure hook: report a usage-limit stall to the proxy so it can fail over.

Claude Code's `--fallback-model` / `fallbackModel` chain is AVAILABILITY-based
(503/529) and explicitly does NOT cover plan usage limits (429) - and there is
no automatic model downgrade on a plan limit. So an interactive topic-Claude
that exhausts its model's quota just stalls: every later turn fails the same
way until a human runs /model.

The one signal the harness does give is this hook: StopFailure fires when a
turn ends on an API error, with error == "rate_limit" for a 429. It is
notification-only (its output is ignored, and it cannot change the session's
model), so it does the one thing it can: tell the proxy, which OWNS the
session lifecycle and can respawn it on the fallback model with --resume (the
--model flag overrides even on resume - that is why per-topic model pinning
works at all).

Fires and forgets: any failure here is swallowed, because a hook that throws
must never make a already-failing turn worse.
"""

import json
import os
import sys
import urllib.request

LOG = os.path.expanduser("~/Library/Logs/telegram-rate-limit-failover.log")


def log(msg: str) -> None:
    try:
        with open(LOG, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def main() -> None:
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return

    # Only usage/rate limits. Other StopFailure causes (transport blips,
    # request-size, auth) are not fixed by switching models, and failing over
    # on them would silently downgrade the model for no reason.
    if hook.get("error") != "rate_limit":
        return

    topic = os.environ.get("TELEGRAM_TOPIC_ID")
    proxy = os.environ.get("TELEGRAM_PROXY_URL")
    if not topic or not proxy:
        log(f"rate_limit hit but no topic/proxy env (topic={topic!r})")
        return

    payload = json.dumps(
        {
            "topic": topic,
            "error": hook.get("error"),
            "details": str(hook.get("error_details", ""))[:500],
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
