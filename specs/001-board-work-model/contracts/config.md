# Contract: work view configuration

The `work` entry in `~/.config/board/boards.json` (or `BOARD_CONFIG`) gains a `model` layout. Other
boards keep their current layouts.

```jsonc
{
  "boards": [
    {
      "id": "work",
      "title": "work",
      "layout": "model",
      "path": "~/workspace/work-board/board.json",   // the local Source
      "sources": {
        "rhythms": {
          "follow": ["OBJ-2346"],                     // goals, by short id; children come along
          "kinds": { "objective": "Objective", "key_result": "Key result" },
          "fresh_minutes": 60
        },
        "linear": {
          "team": "MM",
          "projects": [
            { "name": "CRB Funding - Money Movement", "under": "rhythms:KR-6204" }
          ],
          "kinds": { "project": "Project", "issue": "Task" },
          "fresh_minutes": 10
        },
        "github": {},                                 // Artifacts from the prs boards; no options
        "boards": { "oncall": "on-call" }             // another board's items, under a local Item
      },
      "hosts": { "herdr": { "cwd": "~" } },            // where Sessions run; cwd for started ones
      "harnesses": {                                   // the agent inside them
        "claude": { "args": ["--model", "opus[1m]", "--effort", "xhigh"] }
      },
      "periods": [{ "name": "Q4 2026-27", "start": "2026-11-01", "end": "2027-01-31" }]
    }
  ]
}
```

Rules:

- A Source missing from `sources` is off. With none, the view runs on the local file alone.
- `kinds` maps a Source's own level names to the person's; an unmapped level uses the Source's word
  with its first letter capitalized.
- `under` sets a Source Item's parent once in config, for links no Source holds.
- An unknown key is ignored with one warning line in the view, never an error.

Field example for another discipline, local file only:

```json
{ "id": "work", "layout": "model", "path": "~/thesis/work.json",
  "periods": [{ "name": "Fall 2026", "start": "2026-09-01", "end": "2026-12-20" }] }
```
