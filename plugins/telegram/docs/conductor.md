# The conductor

The conductor is the proxy's second front end: an API for the operator's own
apps (an iOS app first), beside Telegram, over the tailnet only. It is not a
rewrite. The proxy already reaches its chat through `ChatPort`; the conductor
adds a store, an authenticated API and push, and later lets Telegram go.

Status: contract version 1. Built: the store and mirror, the listener with
identity, enrollment, the reads and the stream, signed writes (sending a
message, read markers), push for messages, the ledger `verify.py` checks, and
live agent states with screens for hc topics (`docs/conductor-plan.md` C1 to
C5 and C8). Approval pushes come with approvals (C7), and the rest follows the
plan. The golden
fixtures and signing vectors in `conductor-v1/` are part of the contract: the
server's tests encode them and the app's tests decode them.

## Goals and limits

- The app does what the operator does in Telegram today: see every topic and
  its agent's state, read and send messages (text and images), watch a
  session's screen, answer approvals, switch a model, run commands, drop a
  secret, manage reminders, create and rename topics, ask from the Action
  Button, and get push notifications.
- Telegram keeps working, unchanged, the whole time. Both front ends see the
  same conversation.
- Only the operator, from devices they enrolled, can act as the operator. No
  process on the conductor's machine, an agent session included, can.
- No agent-to-agent traffic goes through the conductor. Agents keep using the
  proxy's internal loopback API through the channel MCP.
- Not in version 1: search, the square feed, Telegram history backfill, styled
  terminal output, the desktop app's extensions, a terminal UI.

## Architecture

```
iOS app ──(tailnet, TLS)──> conductor listener ──┐
                                                  ├── store (SQLite): messages, blobs, approvals, devices, cursor
Telegram ──(Bot API)──> Telegram adapter ─────────┤
                                                  ├── inbound router (unchanged): verbs, secrets, turns
                                                  ├── topic lifecycle (unchanged): hc / herdr / tmux
hc core ──(events.subscribe, terminal.read)──────>┤
                                                  ├── ledger (append-only): operator acts
                                                  └── push: APNs, straight to Apple
```

- **One process.** The conductor runs inside the proxy, as more adapters and
  services, so policy, routing and the launcher stay in one place.
- **The app adapter** implements the inbound half of the chat port: a message
  sent from the app becomes the same `ChatMessage` a Telegram message would,
  with a verified sender, and goes through the same router.
- **Mirroring.** Every message the proxy sends to a topic (agent replies, proxy
  notices) is also written to the store and streamed. Operator messages from
  either front end are stored too, and those sent from the app are echoed into
  the Telegram topic as "You (app): ...", so Telegram stays the full record
  while both exist.
- **The store** is SQLite (WAL) in the state directory. It starts empty at the
  conductor's first run.

## Identity and authority

The proxy's authority model (`CLAUDE.md`, "What an adapter must guarantee")
applies unchanged. The app adapter meets it with three checks: where it
listens, which node is calling, and a signature from the device.

**Where it listens.** On the tailnet address only, never loopback and never all
interfaces, with TLS from the machine's tailnet certificate. It does not sit
behind `tailscale serve`, so no forwarded identity header is part of the trust
path: a loopback port is reachable by every local process, which could set any
header it likes.

**Which node.** For each connection the conductor asks the local Tailscale
client who the peer address belongs to (`whois`). It refuses the conductor's
own node (a local process can reach the listener only from it, and it belongs to
the operator's user, so a user check alone would admit it), any user other
than the configured operator login, and any node not on the operator's
allow-list. The allow-list never contains the conductor's own node.

**Which device.** The app keeps a P-256 key in the device's Secure Enclave,
bound to that device, usable only when unlocked, never exported.

- **Enrollment:** `POST /v1/devices` with the public key, accepted only from an
  allow-listed node. It is written to the ledger and announced in the
  operator's coordinating topic. Revoking a device deletes its row.
- **Every operator write is signed:** sending a message, answering an approval,
  a secret, a route change, a command, a reminder, a topic change, an ask. The
  headers are:

  | Header | Value |
  | --- | --- |
  | `X-Device` | the device id from enrollment |
  | `X-Client-Id` | a fresh id for this request, unique per device |
  | `X-Timestamp` | Unix time in milliseconds |
  | `X-Signature` | base64 DER ECDSA P-256 SHA-256 over the canonical bytes |

  The canonical bytes, joined with `\n`:
  `v1`, the method, the path with its query, the client id, the lowercase hex
  SHA-256 of the exact body bytes (of the empty string when there is no body),
  and the timestamp. A request is refused when the signature does not verify
  or its timestamp is more than 120 s off.
- **Retries are safe.** An app resends a write with the same client id, the
  identical body bytes (a multipart body keeps its boundary), and a fresh
  timestamp and signature, until it gets an answer. A client id the device
  used before with the same body SHA-256 returns the first result and does
  nothing new; with a different body it is refused with 409 `client_id_reused`.
  This holds for every signed write.
- **Reads are not signed.** Topics, history, blobs and the stream need only an
  allow-listed node and a known device id in the `X-Device` header (on the
  WebSocket upgrade request too), because the notification service extension
  fetches a message while the phone may be locked.

**The ledger.** An append-only file of operator acts, one JSON object per line,
each carrying the hash of the line before it: the kind of act, the device, and
for a write what the device signed (method, path, client id, the body's SHA-256,
the timestamp and the signature) with the topic and seq it produced. An
enrollment records the device's name and full public key. Each line is its
hashed body with `"hash"` appended last, so a verifier hashes the bytes as
written. Beside it, `signed-bodies/<sha256>` keeps each signed body of at most
256 KB (a text message; one with images is not kept). `verify.py` reads both to
confirm an operator go that came from the app: the chain holds, the entry is a
message from that device to that topic recorded once, the device's key signed
it, and the signed text is what was delivered. It takes the key from its own
pinned list of devices, never from this machine, so a go is bound to an
enrolled device's key and nothing on the conductor's machine can make one.
Nothing rewrites the ledger.

**An app message is an operator turn.** Its sender was verified (an enrolled
device's signature, from an allowed node), so the agent receives it as the
operator's turn, the same as one from Telegram, marked `origin: app` with the
device and the hash of its ledger entry, which `verify.py` checks against the
ledger. It is also posted into the Telegram topic as "You (app): ...", and the
turn carries that post's id, so the agent's reply threads under it.

**What never carries operator authority:** turns the proxy makes itself
(reminders, notices, square deliveries), and asks, even when an ask is signed.
The ledger records an ask as an ask.

**Service callers** (monitors, CI notifiers) keep posting through the internal
API with named tokens and no operator role.

## Conventions

- JSON with snake_case keys; times are ISO 8601 UTC with milliseconds
  (`2026-11-01T20:25:37.123Z`).
- Topic ids are strings: `general` or a thread id.
- A message has an opaque string `id` and an integer `seq`, gapless per topic.
- Every stream event has an integer `cursor`, increasing across all topics.
- `format` on agent messages is passed through as written (`markdownv2`,
  `markdown` or `plain`); the app renders it.
- Errors: `{"error": {"code": "...", "message": "..."}}` with the HTTP status
  that fits (400, 401, 403, 404, 409, 413, 422, 429, 503).

## Objects

Each has a golden fixture in `conductor-v1/`.

**Topic:** `id`, `name`, `kind` (`claude` or the locked harness's name),
`title` (the session's own title, when it has one), `pinned` (`general` first),
`muted`, `state` (`starting`, `idle`, `working`, `blocked`, `stopped`,
`missing`), `state_since`, `unread`, `read_seq`, `pending_approvals`, `route`
(`provider`, `model`, `effort`), `last_message` (`preview`, `author`, `at`).

**Message:** `id`, `topic`, `seq`, `author` (`operator`, `agent`, `proxy`),
`origin` (`app`, `telegram`, `proxy`), `kind` (`null`, `reminder` or `ask`),
`text`, `format`, `blobs` (`id`, `mime`, `bytes`, `width`, `height`),
`reply_to` (a message id), `at`, `edited_at` (`null` until edited) and
`reactions` (`[{"emoji": "👀"}]`). Operator messages also carry `client_id` and
`delivery` (`accepted`, `delivered`, `failed`), and `failure` when failed. A
reminder firing is a proxy message of kind `reminder`; an ask is posted as a
proxy message of kind `ask`, which the app shows as the operator's own question
and which never counts as an operator act. Posts from service callers through
the internal API read as `agent` until they get named tokens.

**Approval:** `id`, `topic`, `kind` (`permission`, `question`, `auth`),
`prompt`, `choices` (`id`, `label`, `role`: `approve`, `deny` or `null`),
`created_at`, `resolved` (`choice`, `by`, `at`) once answered or expired. A
notification's approve and deny actions answer with the choice of that role.

**Screen:** `topic`, `rows` (plain strings, without trailing blank rows),
`cols`, `cursor` (`row`, `col`, or `null` when the terminal does not report it,
as hc does not), `working`. Not stored.

**Device:** `id`, `name`, `public_key` (base64 of the 65-byte uncompressed
point), `apns_token`, `apns_env` (`sandbox`, `production`), `enrolled_at`,
`last_seen`.

## HTTP

All under `/v1`. "Signed" marks a write that needs the device headers.

| Method and path | | Purpose |
| --- | --- | --- |
| `GET /me` | | the device, the server version |
| `POST /devices` | enrollment | `public_key`, `name`, `apns_token`, `apns_env`; returns the device |
| `PUT /devices/{id}/push` | signed | the device's own `apns_token` (hex, or null for no push) and `apns_env`; returns the device |
| `GET /topics` | | `{cursor, topics}`: every topic, and the cursor they are current to |
| `POST /topics` | signed | create: `name` |
| `PATCH /topics/{id}` | signed | `name`, `pinned`, `muted` |
| `GET /topics/{id}/messages?before_seq=&limit=` | | `{cursor, messages}`: history, newest first, at most 100 |
| `POST /topics/{id}/messages` | signed | multipart: `text` (at most 64 KB), `client_id`, `reply_to`, `image[]` (JPEG or PNG, at most 10, 20 MB each); returns the message with `delivery: accepted`; a repeated `client_id` returns the first result |
| `POST /topics/{id}/read` | signed | `seq`; read state is shared by every device |
| `GET /blobs/{id}?w=` | | a blob's bytes, or a thumbnail at most `w` pixels wide |
| `GET /approvals?state=open` | | `{cursor, approvals}`: open approvals |
| `POST /approvals/{id}` | signed | `choice` |
| `GET /commands` | | `name`, `description`, `args_hint` |
| `POST /topics/{id}/commands` | signed | `name`, `args`: `relaunch`, `interrupt`, `usage`, and the rest of the palette |
| `GET /routes` | | the model catalog: providers, models, efforts |
| `GET /usage` | | quota windows and resets |
| `PUT /topics/{id}/route` | signed | `provider`, `model`, `effort`; returns `applied` or `queued` |
| `GET /secrets` | | names, sizes, dates |
| `POST /secrets` | signed | `name`, `value`, `replace`, `topic`; returns `path`, `bytes`, `replaced` |
| `DELETE /secrets/{name}` | signed | remove one |
| `GET /topics/{id}/reminders` | | `{reminders}`: the topic's pending reminders, soonest first; no cursor, since reminders are not stream events |
| `POST /topics/{id}/reminders` | signed | `at` (with a zone offset), `text`, `prompt` |
| `DELETE /reminders/{id}` | signed | cancel one |
| `POST /ask` | signed | the `/ask` fields; returns the message's `topic` and `seq` |

A secret's value appears in no event, log, message, push or ledger entry.

The existing `POST /ask` on its own listener stays byte-compatible through the
migration.

## The stream: `GET /v1/stream` (WebSocket)

The client opens it with `{"type": "hello", "since": <cursor>}`, usually the
cursor of its last fetch or event. The server replays every event after that
cursor, in order, then sends `{"type": "ready", "cursor": <latest>}` and streams
live events. A `hello` without `since` replays nothing and gets `ready` at once.
If the cursor is older than what the server keeps, it sends
`{"type": "reset"}`, and the client refetches topics and history. Reconnecting
with `since` is the normal path: a suspended app loses its socket within
seconds. Because `GET /topics` and history carry the cursor they are current to,
fetching and then streaming from that cursor misses nothing.

Events, each with `type` and `cursor`, carry whole objects:

- `message`: a stored message, and again when an operator message's `delivery`
  changes, or when it is edited or reacted to
- `topic`: a topic created, renamed, re-routed, or its state, unread or pins
  changed
- `approval`: an approval opened or resolved
- `heartbeat`: at least every 25 s, no cursor

The client sends `{"type": "subscribe", "screen": "<topic>"}` and
`{"type": "unsubscribe", "screen": "<topic>"}`; `screen` events (a whole screen
object, no cursor, never replayed) go only to subscribed connections, at most
twice a second and only when the screen changed, and once on every state
change. A topic with no screen to show (not on hc, its agent not running, or
not listed) answers a subscription with
`{"type": "error", "screen": "<topic>", "error": {"code": "no_screen", ...}}`
and is unsubscribed; the client may subscribe again after the topic's next
state change. The client also pings.

## Approvals

- **A blocked session.** hc reports `blocked` when Claude shows a dialog. The
  conductor reads the screen, offers its numbered choices, and answers by
  sending the chosen keys to the terminal.
- **A permission request** from the channel MCP's permission relay, when it is
  active.

An approval resolves as expired when the session leaves `blocked` without an
answer from the app, for example when the operator answered at the desktop.

## Push

Straight to Apple (APNs, HTTP/2, token authentication with a `.p8` key, its key
id and team id). The APNs topic is the app's bundle id. There are no silent
pushes: iOS throttles them.

- **Agent message:** `alert` (`title`: topic name, `body`: the message's text,
  as much as fits the 4 KB payload), `thread-id`: topic id, `badge`: total
  unread, `mutable-content: 1`, and custom `topic` and `seq`, so the service
  extension can fetch the rest and the thumbnails. Full text goes through Apple
  by the operator's choice; a secret never does.
- **Approval:** category `APPROVAL` (approve and deny actions, authentication
  required), `interruption-level: time-sensitive`, and custom `topic` and
  `approval` (its id).
- **Reminder:** category `REMINDER`, `time-sensitive`.
- No push for edits, for the operator's own messages, for ask posts, for topics
  the app does not list, or for muted topics.
- Each message is pushed once to every device with a token, whatever later
  events name it. A token Apple calls dead (410, or 400 `BadDeviceToken`) is
  dropped; the app sends its current one with `PUT /devices/{id}/push` at launch.
- Delivery times are logged (`push: <topic>#<seq> -> <device> <status> <ms>`,
  and how long after the message was stored), to compare with Telegram's before
  Telegram retires.

## States and the screen

The conductor holds one `events.subscribe` connection to the hc core of the
topics' session, straight to its socket, and keeps the snapshot current from
the events after it (`shared/hc-events.ts`). A `missed` notice, a closed
connection or 45 s without a heartbeat resubscribes, retrying from 1 s up to
30 s. It never starts a core: with none listening, hc topics read `missing`.
Screens are `terminal.read` on a connection of their own, rendered to plain
rows.

A topic on hc takes its state from its terminal: `done`, `idle` and `error`
read `idle`, `working` `working`, `blocked` `blocked`, no report yet
`starting`, and no terminal (or only a shell left) `missing`. Its `title` is the
terminal's title. Any other topic knows only the proxy's lifecycle: `idle`
while its agent runs, `stopped`, or `missing` after a failed start. A failed or
stopped agent reads that way on hc too. `state_since` is when the conductor saw
the state begin, `null` for a state that held when it started.

The topic list is compared with what was last seen whenever hc reports a
change and every 2 s (for the lifecycle's own changes); a changed state, title,
name or route, or a new topic, is a `topic` event.

## Coexistence and rollout

- The conductor is off unless `CONDUCTOR_LISTEN` is set. Off, nothing changes.
- Telegram's behavior does not change until cutover, which is a separate
  decision.
- Every step merges with tests, is rehearsed against copied state, and is
  turned on only after the operator's coordinating topic has been told.

## Open questions

- Skills in the command palette, if listing them is cheap.
- Thumbnail sizes worth caching on the server.
