#!/usr/bin/env python3
"""Claude status-line adapter: report Anthropic quota windows to the proxy."""

from __future__ import annotations

import json
import os
import sys
import urllib.request


def as_millis(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number if number > 10_000_000_000 else number * 1000)


def main() -> None:
    try:
        status = json.load(sys.stdin)
    except Exception:
        return

    provider = os.environ.get("TG_PROVIDER", "anthropic")
    model = os.environ.get("TG_MODEL", "default")
    effort = os.environ.get("TG_EFFORT", "")
    print("Claude · %s · %s%s" % (provider, model, (" · " + effort) if effort else ""))

    if provider != "anthropic":
        return
    proxy = os.environ.get("TELEGRAM_PROXY_URL")
    topic = os.environ.get("TELEGRAM_TOPIC_ID")
    limits = status.get("rate_limits") or {}
    if not proxy or not topic or not limits:
        return

    windows = []
    for key, name in (("five_hour", "5 hour"), ("seven_day", "7 day")):
        raw = limits.get(key) or {}
        used = raw.get("used_percentage", raw.get("used_percent"))
        if used is None:
            continue
        try:
            percent = float(used)
        except (TypeError, ValueError):
            continue
        window = {
            "name": name,
            "used_percent": percent,
            "availability": "exhausted" if percent >= 100 else "available",
        }
        reset = as_millis(raw.get("resets_at"))
        if reset:
            window["resets_at"] = reset
        windows.append(window)
    if not windows:
        return

    body = json.dumps({"provider": "anthropic", "topic": topic, "windows": windows}).encode()
    request = urllib.request.Request(
        proxy + "/capacity",
        data=body,
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=2).read()
    except Exception:
        pass


if __name__ == "__main__":
    main()
