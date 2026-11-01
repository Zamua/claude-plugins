// The review board from pr-review-board's docs/REVIEW-RULES.md, with one comment per
// severity its checker accepts. The object below is plain JSON:
// pr-review-board's tests/test_board_contract.sh parses it and holds it to both.
export const EXAMPLE = {
  "schema": 2,
  "updated_at": "2026-10-21T13:50:00Z",
  "title": "Stock ledger rejects negative adjustments",
  "verdict": "medium",
  "risk": "One sentence: what could go wrong, and how bad.",
  "blast_radius": "One sentence: who is affected, from when.",
  "prs": [
    {
      "pr": "example-org/inventory-service#1234",
      "number": 1234,
      "title": "Reject negative stock",
      "url": "https://github.com/example-org/inventory-service/pull/1234",
      "risk": "medium",
      "head": "<sha>",
      "author": "octocat"
    },
    {
      "pr": "example-org/inventory-service#1240",
      "number": 1240,
      "title": "Sweep the ledger",
      "url": "https://github.com/example-org/inventory-service/pull/1240",
      "risk": "low",
      "head": "<sha>",
      "author": "octocat",
      "base": "example-org/inventory-service#1234"
    }
  ],
  "stacks": [
    {
      "id": "ledger",
      "title": "Stock ledger",
      "verdict": "medium",
      "risk": "One sentence for this stack alone.",
      "blast_radius": "One sentence for this stack alone.",
      "prs": [
        "example-org/inventory-service#1234",
        "example-org/inventory-service#1240"
      ]
    }
  ],
  "report": [
    {
      "id": "about",
      "title": "What this change is about",
      "markdown": "..."
    }
  ],
  "comments": [
    {
      "n": 1,
      "pr": "example-org/inventory-service#1234",
      "severity": "medium",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "One sentence, shown on the row.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    },
    {
      "n": 2,
      "pr": "example-org/inventory-service#1234",
      "severity": "live",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "A finding rated live.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    },
    {
      "n": 3,
      "pr": "example-org/inventory-service#1234",
      "severity": "high",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "A finding rated high.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    },
    {
      "n": 4,
      "pr": "example-org/inventory-service#1234",
      "severity": "low-medium",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "A finding rated low-medium.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    },
    {
      "n": 5,
      "pr": "example-org/inventory-service#1234",
      "severity": "low",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "A finding rated low.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    },
    {
      "n": 6,
      "pr": "example-org/inventory-service#1234",
      "severity": "question",
      "confidence": "proven",
      "origin": "new",
      "status": "proposed",
      "summary": "A finding rated question.",
      "path": "src/main/kotlin/StockLedger.kt",
      "line": 88,
      "side": "RIGHT",
      "body": "The comment exactly as it would post, without the sign-off.",
      "detail": "Markdown: the finding in full, for the operator.",
      "origin_note": "Why it is new or carried over.",
      "target": "StockLedger.kt:88",
      "location_url": "https://github.com/<owner>/<repo>/blob/<head-sha>/<path>#L88",
      "files": [
        {
          "label": "StockLedger.kt:80-95",
          "url": "..."
        },
        {
          "label": "NegativeStockScratchTest",
          "url": "<link to the test>",
          "kind": "test"
        }
      ],
      "posted_url": null,
      "addressed": false,
      "addressed_note": null
    }
  ]
}
