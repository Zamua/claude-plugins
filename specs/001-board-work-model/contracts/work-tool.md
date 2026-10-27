# Contract: `mcp__board__work`

The tool Claude calls to read the tree, change the local file and start Sessions. Main conversation
and subagents alike, since coordinators file work for their workers.

## Input

Every field is optional; the changes apply together, or none do.

| Field | Shape | Effect |
|---|---|---|
| (none) | | returns the tree as text, below |
| `add` | `{ title, kind, parent?, shape?, status?, origin?, target?, detail?, links? }[]` | adds local Items; returns their ids |
| `update` | `{ id, title?, kind?, parent?, status?, origin?, target?, detail?, links? }[]` | changes local Items; `parent` moves one, which is how an Inbox ask is placed |
| `remove` | `id[]` | removes local Items with no children |
| `link` | `{ child, parent }[]` | sets a hand link for any Item, Session or Artifact; a Session parent sets a Coordinator |
| `unlink` | `child[]` | removes hand links |
| `attach` | `parent` | links the calling session to `parent`: shorthand for `link` with this session as child |
| `start` | `{ item, brief, label?, cwd?, again? }[]` | starts a Session for each Item through the Host, linked under the Item with the calling session as Coordinator |
| `root` | `true` | makes the calling session the root session |

`start` labels the Session after the Item, its first alias then its title, in lowercase kebab case
of at most five words, unless `label` is given. `cwd` defaults to the Host's configured `cwd`.

## Refusals

A change is refused whole, with the reason, when it names an unknown id, edits an Item another
Source owns (only `link` may touch those), would make an Item its own ancestor, removes an Item
that still has children, or starts a Session for an Item that already has a running one without
`again: true`. A refusal names the running Session and its message name, so the caller can message
it instead.

## Result

`Work updated. Added <ids>. Started <session ids>.` for a change. A read returns one line per Item
with id, kind, status and needs count, and beneath each Item one line per Session:

```text
file:crb [Project, flight, 1 need you] CRB integration
  session:herdr:default/w9 [working] crb-integration, message zamua-85
    goal: Land the CRB funding flows
    summary: one PR in review, one waiting on a decision
```

The board redraws in every session showing the work view.
