# Technical notes

## Envelope budget
The MCP response budget is 32KB serialized. `browser_scrape` caps extracted text
at 22KB and html preview at 4KB; batch items carry title + 1.2KB text excerpt.
The output shrink loop halves `html`/`text`/`markdown` fields up to 5 rounds
before failing the call.

## Failover contract
`trawl-adapter.mjs` classifies failures:
- **Probe timeouts** (4s) → consecutive-timeout counter → exponential cooldown
  60s→240s (capped). Healthy probe resets.
- **TRAWL solve errors** (`status:"error"` envelope) → target-side failure;
  availability state untouched; failures counter stays 0.
- **TRAWL HTTP 4xx** → request-level; recorded, availability kept.
- **TRAWL HTTP 5xx / transport / deadline** → endpoint struggling; availability
  flipped + breaker armed.
- **Caller abort** → `caller_abort` reason, zero state pollution.

## Container hardening (VPS endpoint)
Read-only rootfs, `cap_drop: ALL` (+ minimal additions for the browser tier),
`no-new-privileges`, tmpfs for browser profile dirs, non-root Redis, DNS pinned
to public resolvers, no Docker socket, no host bind mounts. See the compose
example in your deployment notes.

## Cloudflare edge specifics
- Raw TCP port 53 is intercepted (0-byte replies) — use DoH for DNS.
- No ClientHello control in worker `fetch` — TLS impersonation lives in the
  TRAWL browser tier.
- `cloudflare:sockets` `connect()` is available in the runtime (probed by
  `browser_edge_probe`).

## State ownership

| State | Lives in | Lifetime |
|---|---|---|
| Availability probe / circuit breaker / failure counters | Sites worker isolate (in-memory) | per isolate, resets on deploy/eviction |
| TRAWL cookie sessions (scraped-site cookies) | VPS Redis | TTL 3600s, disposable by design |
| Caller credentials (headers, bodies) | explicit tool arguments only | per call |
| Cached public reads | Sites worker in-memory cache | 15-60s TTL |
| No state | ChatGPT client, browser (the MCP client holds none) | — |
