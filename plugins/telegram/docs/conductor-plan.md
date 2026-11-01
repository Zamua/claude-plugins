# The conductor: build plan

How `conductor.md` gets built. Every step is merged with tests, behind
`CONDUCTOR_LISTEN` (unset: nothing changes), and turned on only after the
operator's coordinating topic has been told. Telegram keeps working through all of it.

Estimates are working days for one agent, not measurements.

| Step | What | Days | Done when |
| --- | --- | --- | --- |
| C0 | The API contract, agreed with the app's owner | 0.5 | Both sides sign off on `conductor.md` and vendor the fixtures in `conductor-v1/` |
| C1 | Store and mirror | 2 | Every message to and from a topic is in SQLite, with seq and cursor, and Telegram is unchanged |
| C2 | Listener, identity and enrollment, read-only API | 3 | A development build enrolls, then lists topics and history over the tailnet; a request from this machine is refused |
| C3 | Signed writes and sending | 2 to 3 | A signed message reaches the right session once, across a restart, and shows in Telegram; every signing vector passes |
| C4 | The ledger | 1 to 2 | Every operator act is in the hash-chained ledger, and `verify.py` accepts a go from the app |
| C5 | Agent states and terminal tail | 2 | The app shows live states and a session's screen |
| C6 | Commands | 3 | Route switch, slash commands, secret drop and reminders from the app |
| C7 | Approvals | 2 | A blocked session's dialog is answered from the app with a signed answer |
| C8 | Push | 2 to 3 | Agent messages and approvals arrive as notifications; delivery time measured against Telegram |

Total: about 18 to 21 working days, 3.5 to 4 weeks, in parallel with the app.

## Steps

**C1, store and mirror.** SQLite (`bun:sqlite`, WAL) in the state directory.
Outbound capture is a decorator around the chat port, so no caller changes and
the Telegram adapter stays as it is. Inbound operator messages are recorded where
the router hands them on. Tests: the schema, cursor order, gapless seq per
topic, the decorator against a fake port.

**C2, listener, identity and enrollment.** Bind the tailnet address with the
machine's tailnet certificate. `whois` on each connection's peer address
(`requestIP`), cached by node, refusing this machine's own node, other users
and nodes off the allow-list. Enrollment stores a device's public key and is
written to the ledger. Endpoints: `/v1/me`, `/v1/devices`, `/v1/topics`,
history, blobs, `/v1/stream` with `hello` replay and heartbeats. Tests: identity
decisions as pure functions (self, wrong user, unknown node, allowed node),
replay order, the reset on an expired cursor, the fixtures. Operator step: put
the phone's node on the allow-list.

**C3, signed writes and sending.** Signature verification on every write (the
canonical bytes, the 120 s window, client ids never reused), against the signing
vectors. Then multipart text and images, `client_id` idempotency stored in
SQLite (a retry after a restart returns the first result), and the message
handed to the router as a `ChatMessage` whose sender is the operator, with
`delivery` moving from `accepted` to `delivered` or `failed`. It is echoed into
Telegram as "You (app): ...". Test: the exactly-once gate across a conductor
restart, end to end.

**C4, ledger.** Append-only JSON lines, each with the previous line's hash,
fsynced before the act takes effect. `verify.py` (in the operator's infra
repository) learns to read it. Test: a tampered or reordered ledger fails
verification.

**C5, states and terminal.** One `events.subscribe` connection to the hc core
(states into the store and the stream), and `terminal.read` at most twice a
second for topics a client watches. It resubscribes after a core restart and
never starts a core.

**C6, commands.** Route read and switch through the route flow, `relaunch` and
`usage`, the secret drop (value written straight to the secrets directory, never
stored, logged or echoed), reminders through the existing repository, and read
markers.

**C7, approvals.** A `blocked` state opens an approval from the dialog on
screen; the signed answer is sent as keys. The approval expires when the session
leaves `blocked` on its own.

**C8, push.** APNs over HTTP/2 with a token from the `.p8` key. Message and
approval payloads as in `conductor.md`, device tokens from `/v1/devices/push`,
and tokens Apple reports as invalid dropped. Delivery times are logged for the
comparison with Telegram. Operator step: the `.p8` key (through the secret drop),
its key id, the team id and the app's bundle id.

## What the operator provides

- Each device's node on the allow-list (C2); enrollment itself happens from the device.
- The APNs key and its ids (C8).
- A go before each step's listener or behavior is turned on.

## Risks

- **Identity.** Everything rests on refusing this machine's own node and every
  unenrolled node. C2 does not merge without tests of each refusal and a manual
  check from an agent session on this machine.
- **HTTP/2 to Apple from Bun.** Bun has a `node:http2` client, but no connection
  to APNs has been made yet; C8 starts with that spike, with a small helper
  process as the fallback.
- **The hc socket.** Every hc terminal can reach its core's socket and type into
  any session. The conductor does not fix that; isolating the socket is its own
  piece of work and comes before approvals are trusted from the app.
- **History.** The store starts empty; Telegram keeps the older history.
