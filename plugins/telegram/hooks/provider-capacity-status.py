#!/usr/bin/env python3
"""Claude status-line adapter: report Anthropic quota windows to the proxy, and
keep the latest in a file other readers (the Crook backend) tail."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.request


def as_millis(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number if number > 10_000_000_000 else number * 1000)


def usage_file() -> str:
    return os.environ.get("CROOK_USAGE_FILE") or os.path.join(os.path.expanduser("~"), ".local", "state", "crook", "usage.json")


def keep_usage(provider: str, windows: list) -> None:
    """Replace this provider's windows in the usage file, keeping the others'.

    Written as a 0600 temp file renamed into place, so a reader never sees half a
    file. An unreadable file is replaced rather than merged.
    """
    path = usage_file()
    try:
        with open(path) as handle:
            report = json.load(handle)
        providers = report.get("providers") if isinstance(report, dict) else None
        if not isinstance(providers, dict):
            providers = {}
    except Exception:
        providers = {}
    providers[provider] = {"windows": windows, "observed_at": int(time.time() * 1000)}
    folder = os.path.dirname(path)
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=folder, prefix=".usage-", suffix=".tmp")
        with os.fdopen(fd, "w") as handle:
            json.dump({"providers": providers}, handle)
        os.replace(temp, path)
    except Exception:
        pass


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
    if not limits:
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
    keep_usage("anthropic", windows)
    if not proxy or not topic:
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
