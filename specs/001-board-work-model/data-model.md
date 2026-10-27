# Data Model: Board Work Model

The core types name no tool or field (Constitution III). Adapters produce them; the view and the
tool consume them.

## Item

| Field | Type | Notes |
|---|---|---|
| `id` | string | `<source>:<native id>`, e.g. `file:split-closeout`, `linear:MM-809`, `rhythms:KR-6204` |
| `source` | string | the Source that owns the Item's content |
| `kind` | string | the person's name for its level, e.g. `Task` |
| `title` | string | one line |
| `url` | string? | where to open it |
| `shape` | `outcome` \| `responsibility` | a Responsibility never ends and has no target date |
| `status` | Status | the Item's own status, before rollup |
| `origin` | Origin? | why it exists |
| `parent` | ItemId? | from its Source; a Link overrides it |
| `aliases` | string[] | identifiers a Session or Artifact may carry, e.g. `MM-809` |
| `target`, `started`, `finished` | ISO date? | `target` is the deadline |
| `progress` | number? | 0 to 100, when the Source has one |
| `checkinDue` | ISO date? | when the Source expects the next check-in |
| `owner` | string? | display name |
| `detail` | string? | markdown, shown when pressed open |
| `links` | {label, url}[] | extra links |

Validation: `id` unique across Sources; a Responsibility drops `target`; `parent` must exist and
must not make the Item its own ancestor, or the Item goes to the top level with a warning.

## Status

`needs` (needs you), `flight` (in flight), `waiting`, `next`, `watching`, `done`, in that urgency
order. A parent's shown status is the most urgent among itself and its descendants; its
`needsCount` counts descendants whose own status is `needs`.

## Origin

`{ type: 'planned' | 'asked' | 'interrupt' | 'self', by?: string }`. `asked` with no parent places
the Item in the Inbox.

## Session

| Field | Type | Notes |
|---|---|---|
| `id` | string | `session:<Claude session id>` |
| `label` | string | the herdr workspace label |
| `workspace` | string | herdr session and workspace id, for focusing it |
| `state` | string | herdr's status word |
| `parent` | ItemId \| SessionId? | a Link, else the alias match |
| `activeMs` | number | from the transcript (research R5) |

## Artifact

| Field | Type | Notes |
|---|---|---|
| `id` | string | `pr:<owner>/<repo>#<n>` |
| `title`, `url`, `branch` | string | |
| `facts` | PR facts | the prs view's existing facts: state, CI, review, needs you |
| `parent` | ItemId? | a Link, else the alias match |

## Link

`{ child: ItemId | SessionId | ArtifactId, parent: ItemId | SessionId, at: ISO time }`, stored in
the local file. One Link per child; a new one replaces the old. A Link whose parent no Source has
any more is kept and shown as dangling.

## Period

`{ name: string, start: ISO date, end: ISO date }`, from config. An Item is in a Period when any
of its dates falls inside it, or when a descendant is.

## Tree (derived, never stored)

Built in memory from the local file, the Source caches and the Links:

1. Gather Items from every Source; apply Links over Source parents.
2. Attach Sessions and Artifacts by Link, else by alias match (research R6), else to Unplaced.
3. Roll up Status, `needsCount` and `activeMs` from the leaves.
4. Top level, in order: Outcomes, then Responsibilities, then Inbox, then Unplaced.

## State transitions

Status changes only in its Source: the local file through the tool, external Items when their
Source changes. Done Outcomes fold behind a "N done" count at their level.
