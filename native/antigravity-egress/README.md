# antigravity-egress

Local relay for Klaus engine traffic bound for the Antigravity service.

The engine speaks plain HTTP to this relay over loopback. The relay re-issues
each request over its own Go `net/http` TLS stack to the allowlisted upstream
host named by the `X-Egress-Target` request header, so upstream connections
originate from the same HTTP/TLS stack that the hub protocol components use.
Responses stream back with per-chunk flushing, so server-sent event streams
stay live end to end.

## Protocol

- Every request must carry `X-Egress-Token: <shared secret>`; the secret is
  handed to the relay via `KLAUS_EGRESS_TOKEN` at spawn time. Mismatch → 403.
- `X-Egress-Target: <host>` selects the upstream from the allowlist
  (`daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com`,
  `oauth2.googleapis.com`). Unknown target → 400.
- Method, path, query, body and remaining headers are forwarded as-is
  (hop-by-hop headers are dropped). Response status, headers and body are
  streamed back unchanged.
- `GET /egress-healthz` (with token) returns `ok`.

## Lifecycle

- Listens on `127.0.0.1` with an ephemeral port and prints
  `READY 127.0.0.1:<port>` on stdout once serving.
- Exits when stdin closes (the parent engine process is gone) or on
  SIGINT/SIGTERM. It never outlives its parent.

## Environment

- `KLAUS_EGRESS_TOKEN` (required unless `KLAUS_EGRESS_TOKEN_FILE` is set):
  shared request secret.
- `KLAUS_EGRESS_TOKEN_FILE` (optional): path to a file whose trimmed contents
  are the shared secret; used when secret-file provisioning is preferred.
- `KLAUS_EGRESS_UPSTREAM_OVERRIDE` (diagnostics only): `host:port` that
  replaces the upstream dial address, used by local wire-fidelity harnesses.
- `KLAUS_EGRESS_CA_FILE` (diagnostics only): PEM file added as the upstream
  trust root, used by local wire-fidelity harnesses; production runs use the
  platform trust store.

## Build

`./build.sh [output-dir]` cross-compiles all bundled platforms (stdlib only,
`CGO_ENABLED=0`). Go >= 1.27.4 is required: the module language version pins
the transport defaults (including post-quantum hybrid key agreement) that the
upstream handshake shape depends on. Release packaging places the platform
binary next to the engine binary as `antigravity-egress`(`.exe`); the engine
discovers it there or via `KLAUS_ANTIGRAVITY_EGRESS=/path/to/binary`. Without
a discoverable relay the engine talks to the service directly and behavior is
unchanged.
