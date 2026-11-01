#!/usr/bin/env python3
"""Builds the iOS Shortcut that asks Claude by voice: Dictate Text, POST it to /ask,
show the answer as a notification.

    build-ask-shortcut.py --url https://<host>/ask --token-file ~/keys/telegram-ask-token --out Ask.shortcut

The token is written into the shortcut, so the output is a credential: keep it
0600, never commit it, and rebuild it after rotating the token. Signing runs
`shortcuts sign --mode anyone`, which needs a Mac signed in to iCloud; with
--unsigned the plist is written as is.
"""
import argparse
import os
import plistlib
import subprocess
import sys
import tempfile
import uuid

TOKEN_CHAR = "￼"  # where a variable sits inside a Shortcuts text field


def text(value):
    return {"Value": {"string": value}, "WFSerializationType": "WFTextTokenString"}


def output(action_uuid, name):
    return {"OutputUUID": action_uuid, "Type": "ActionOutput", "OutputName": name}


def text_with(prefix, variable):
    return {
        "Value": {
            "string": prefix + TOKEN_CHAR,
            "attachmentsByRange": {"{%d, 1}" % len(prefix): variable},
        },
        "WFSerializationType": "WFTextTokenString",
    }


def variable(var):
    return {"Value": var, "WFSerializationType": "WFTextTokenAttachment"}


def fields(pairs):
    return {
        "Value": {"WFDictionaryFieldValueItems": [{"WFItemType": 0, "WFKey": text(k), "WFValue": v} for k, v in pairs]},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(identifier, **params):
    return {"WFWorkflowActionIdentifier": identifier, "WFWorkflowActionParameters": params}


def notification(body):
    return action("is.workflow.actions.notification", WFNotificationActionTitle="Claude", WFNotificationActionBody=body)


def build(url, token, wait):
    dictated, contents, answer, branch = (str(uuid.uuid4()).upper() for _ in range(4))
    question = output(dictated, "Dictated Text")
    reply = output(answer, "Dictionary Value")
    actions = [
        action("is.workflow.actions.dictatetext", UUID=dictated, WFDictateTextStopListening="After Pause"),
        action(
            "is.workflow.actions.downloadurl",
            UUID=contents,
            WFURL=url,
            WFHTTPMethod="POST",
            ShowHeaders=True,
            WFHTTPHeaders=fields([("Authorization", text(f"Bearer {token}"))]),
            WFHTTPBodyType="Form",
            WFFormValues=fields([
                ("question", text_with("", question)),
                ("wait", text(str(wait))),
                ("client", text("shortcut")),
            ]),
        ),
        action(
            "is.workflow.actions.getvalueforkey",
            UUID=answer,
            WFDictionaryKey="answer",
            WFGetDictionaryValueType="Value",
            WFInput=variable(output(contents, "Contents of URL")),
        ),
        action(
            "is.workflow.actions.conditional",
            GroupingIdentifier=branch,
            WFControlFlowMode=0,
            WFCondition=100,  # has any value
            WFInput={"Type": "Variable", "Variable": variable(reply)},
        ),
        notification(text_with("", reply)),
        action("is.workflow.actions.conditional", GroupingIdentifier=branch, WFControlFlowMode=1),
        notification(text("Asked. The answer will land in Telegram.")),
        action("is.workflow.actions.conditional", GroupingIdentifier=branch, WFControlFlowMode=2),
    ]
    return {
        "WFWorkflowActions": actions,
        "WFWorkflowClientVersion": "2700.0.4",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
        "WFWorkflowImportQuestions": [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": [],
        "WFQuickActionSurfaces": [],
        "WFWorkflowHasShortcutInputVariables": False,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", required=True, help="the tailnet /ask URL")
    p.add_argument("--token-file", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--wait", type=int, default=25, help="seconds the proxy waits for a short answer")
    p.add_argument("--unsigned", action="store_true")
    a = p.parse_args()
    token = open(os.path.expanduser(a.token_file)).read().strip()
    if not token:
        sys.exit(f"{a.token_file} is empty")
    out = os.path.expanduser(a.out)
    old = os.umask(0o077)
    try:
        if a.unsigned:
            with open(out, "wb") as fh:
                plistlib.dump(build(a.url, token, a.wait), fh, fmt=plistlib.FMT_BINARY)
            return
        with tempfile.TemporaryDirectory() as tmp:
            unsigned = os.path.join(tmp, "unsigned.shortcut")
            with open(unsigned, "wb") as fh:
                plistlib.dump(build(a.url, token, a.wait), fh, fmt=plistlib.FMT_BINARY)
            subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", out], check=True)
        os.chmod(out, 0o600)
    finally:
        os.umask(old)


if __name__ == "__main__":
    main()
