# Conductor contract, version 1: fixtures

Golden examples of every object and stream event in `../conductor.md`. The
server's tests must produce exactly these shapes, and the app's tests must
decode them; a change to either side that breaks one fails a test.

`signing.json` holds a P-256 public key (the 65-byte uncompressed point, base64)
and requests signed with its private key, which is not kept. Each vector gives
the canonical bytes, the body's SHA-256 and the DER signature; `valid` says
whether it must verify. The last two are tampered after signing and must fail.

`app_public_key` and `app_vectors` are signatures made by the app's Secure
Enclave code over the same canonical bytes; the server's verifier must accept
them. Retried writes reuse a client id with a fresh timestamp, so those vectors
are not a replay test.
