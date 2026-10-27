# Contract: `mcp__board__work`

The tool Claude calls to read the tree and change the local file. Main conversation and subagents
alike, since coordinators file work for their workers.

## Input

Every field is optional; the changes apply together, or none do.

| Field | Shape | Effect |
|---|---|---|
| (none) | | returns the tree as text: one line per Item with id, kind, status and needs count |
| `add` | `{ title, kind, parent?, shape?, status?, origin?, target?, detail?, links? }[]` | adds local Items; returns their ids |
| `update` | `{ id, title?, kind?, parent?, status?, origin?, target?, detail?, links? }[]` | changes local Items; `parent` moves one, which is how an Inbox ask is placed |
| `remove` | `id[]` | removes local Items with no children |
| `link` | `{ child, parent }[]` | sets a hand link for any Item, Session or Artifact |
| `unlink` | `child[]` | removes hand links |
| `attach` | `parent` | links the calling session to `parent`: shorthand for `link` with this session as child |

## Refusals

A change is refused whole, with the reason, when it names an unknown id, edits an Item another
Source owns (only `link` may touch those), would make an Item its own ancestor, or removes an Item
that still has children.

## Result

`Work updated. Added <ids>.` or the tree text for a read. The board redraws in every session
showing the work view.
