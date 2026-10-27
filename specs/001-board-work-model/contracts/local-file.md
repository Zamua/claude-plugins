# Contract: local file, format version 2

The file holds what no other Source has: Responsibilities, side projects, Items the person keeps by
hand, unplaced asks, and Links.

```jsonc
{
  "version": 2,
  "updated_at": "2026-10-27T14:00:00Z",
  "next_ref": 49,
  "items": [
    { "id": "tooling", "title": "Tooling", "kind": "Responsibility", "shape": "responsibility",
      "status": "flight" },
    { "id": "hostit", "ref": 12, "title": "hostit", "kind": "Project", "parent": "tooling",
      "status": "flight", "links": [{ "label": "site", "url": "https://hostit.withcherry.com" }] },
    { "id": "hostit-48", "ref": 48, "title": "Decide hostit site list and comments", "kind": "Task",
      "parent": "hostit", "status": "needs",
      "origin": { "type": "asked", "by": "Hasan" }, "target": "2026-10-30" }
  ],
  "root": "session:herdr:default/w1",
  "links": [
    { "child": "session:herdr:default/w9", "parent": "crb-architecture",
      "at": "2026-10-27T14:00:00Z" },
    { "child": "session:herdr:default/w9", "parent": "session:herdr:default/w1",
      "at": "2026-10-27T14:00:00Z" }
  ]
}
```

Item fields are those of the data model's Item, minus `source` (always `file`) and with `id`
local to the file. `ref` keeps the work board's `#N` numbers. `root` names the root session. A
Session may have two Links, one to an Item and one to its Coordinator. Unknown fields are kept on
rewrite.

## Migration from version 1

A version 1 file (`groups` plus `items` with a `section`) is rewritten once, after a copy is saved
beside it as `board.v1.json`:

| Version 1 | Version 2 |
|---|---|
| group without `parent` | Item, kind `Project`, shape `outcome`; the group with id `tooling` becomes a Responsibility |
| group with `parent` | Item, kind `Project`, `parent` kept |
| group `source`, `links` | Item `links`, the source first |
| item | Item, kind `Task`, `parent` its `group` |
| item `section` | `status`, same word |
| `due`, `due_label` | `target`, `target_label` |
| `workspace` | a Link from that workspace's session, once it is seen |
| `ref`, `detail`, `links`, `source` | kept |

The migration reports counts before and after, and any item it could not place.
