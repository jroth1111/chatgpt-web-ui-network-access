# Network access tools for ChatGPT web UI

A self-hosted MCP backend giving a ChatGPT conversation **unrestricted owner-directed
network access**: arbitrary HTTP fetch (any method, caller headers, bodies), raw TCP
sockets, outbound WebSockets, and browser-grade scraping with challenge solving —
plus a full guarded public-read stack with DNS admission.

Deploy your own instance and connect it to your ChatGPT account. This repository
contains the application source — not a hosted public service.

## Mental model

```text
ChatGPT conversation (select / mention your connected app)
    │ managed OAuth + MCP tool calls
    ▼
ChatGPT Sites worker (this source): 16 MCP tools
    ├─ guarded public reads (DNS admission, quality gates, 32-item batches)
    ├─ browser_open_fetch — unrestricted HTTP(S), any method/headers/body
    ├─ edge tools — raw TCP (cloudflare:sockets), WebSockets, DNS-over-TCP probe
    └─ browser_scrape(_batch) — browser-grade tier with automatic failover
         ▼
Operator TRAWL endpoint (your VPS, FlareSolverr-compatible; optional)
```

- **ChatGPT web UI is the client.** Tools return structured JSON evidence — status,
  headers, extracted text, hashes, timings — not merely a completion status.
- **Failover is explicit, never silent.** When the browser-grade endpoint is
  unavailable, `browser_scrape` returns `route:"fallback"` with a reason so the
  model can retry via `browser_read_page` / `browser_open_fetch`.
- **Two hardening layers:** the guarded stack keeps DNS admission and quality
  gates for public reads; `browser_open_fetch` trades those for unrestricted
  reach. Both disclose which path served the result.

## Tools (16)

| Tool | Purpose |
|---|---|
| `browser_capabilities` | Measured runtime contract: engines, limits, tool inventory |
| `browser_render_demo` | Fixed in-process DOM/JS demo proving script execution |
| `browser_read_page` | Guarded public page → clean Markdown, title, links |
| `browser_execute_page` | Opt-in: run page scripts in QuickJS WASM/LinkeDOM |
| `browser_observe` | Structural DOM roles/targets, caller-held plans |
| `browser_extract` | Deterministic bounded rows/fields from selectors |
| `browser_acquire` | Static article/catalog/media acquisition with presets |
| `browser_network_request` | Guarded public GET/HEAD with admission + quality gate |
| `browser_acquire_batch` | Up to 32 ordered acquisitions, 8 concurrent |
| `browser_open_fetch` | Unrestricted HTTP(S): any host, method, headers, body; 60s/32MB |
| `browser_edge_probe` | Measured runtime capability probe (raw TCP, WebSocket, Caches) |
| `browser_edge_tcp` | Raw TCP to any host:port (starttls/TLS), bounded reads |
| `browser_edge_websocket` | Outbound WebSocket, send + receive messages |
| `browser_edge_dns_tcp` | DNS A query over raw TCP (demonstrates non-HTTP egress) |
| `browser_scrape` | Browser-grade scrape via operator TRAWL endpoint; readability extraction; shell detection; failover |
| `browser_scrape_batch` | Parallel 2–10 URL scrape, 4-way concurrency, per-item isolation |

## Highlights

- **Readability extraction**: `browser_scrape` returns cleaned text/title/links
  server-side (22KB cap) — the model sees content, not truncated HTML.
- **SPA/login-shell detection**: results flag `app_shell_suspected` with reasons
  (SPA mount nodes, low visible text, login screens) so JS-heavy pages route to
  the browser tier instead of producing empty shells.
- **Circuit breaker**: consecutive probe timeouts widen cooldown exponentially
  (60s→240s, capped); healthy responses reset it; solve errors and caller aborts
  never pollute availability state.
- **Anti-herd jitter**: probe retries stagger across isolates.
- **4xx/5xx classification**: TRAWL request-level errors don't block subsequent
  unrelated URLs; only endpoint-health failures do.

## Install

### 1. Prerequisites

Node.js 22.13+, a ChatGPT account with Sites access, and (optional, for
`browser_scrape`) a Docker/Dokploy VPS for the TRAWL browser-grade endpoint.

```sh
git clone https://github.com/YOUR_USERNAME/chatgpt-web-ui-network-access.git
cd chatgpt-web-ui-network-access
npm install
node tests/run.mjs      # workerd protocol suite
node tests/friction.mjs # adapter/readability/circuit-breaker suite
node build.mjs          # dist/server/index.js + quickjs.wasm
```

### 2. Deploy the Sites worker

**Deployment happens through ChatGPT's Sites workflow — not `git push`.**

1. Open **Work** in ChatGPT web (or ask a Sites-capable agent) and reference this
   repository. Give it the source and ask it to create a private Site with the
   `mcp` capability (`.openai/hosting.json` is included).
2. Set environment bindings in **Site settings** (names only enter source;
   values stay private):

   | Binding | Purpose |
   |---|---|
   | `OWNER_EMAIL` | Your authorized owner identity |
   | `TRAWL_URL` | (optional) Your TRAWL endpoint base URL for `browser_scrape` |
   | `TRAWL_TOKEN` | (optional) Basic-auth password for that endpoint |

   Without `TRAWL_URL`, `browser_scrape` returns `route:"fallback"` with
   `trawl_not_configured` — the other 15 tools work regardless.

3. Publish the approved version and capture the HTTPS origin. Append `/mcp`
   for the MCP endpoint.

### 3. (Optional) Browser-grade endpoint on your VPS

Run a FlareSolverr-compatible scraper (e.g. [TRAWL](https://github.com/germondai/trawl))
behind an HTTPS reverse proxy with Basic auth. See `TECHNICAL_NOTES.md` for the
hardened Compose pattern: read-only containers, dropped capabilities, non-root
services, and a Traefik basic-auth middleware.

### 4. Connect ChatGPT web UI

Install the Site-generated plugin from its card (Plugins → Personal → Created by
you), complete the managed authorization, and mention the app in a new chat.
Verify with `browser_capabilities` — it reports the measured tool inventory.

## Security notes

- Owner identity headers are trusted only behind the Sites dispatch gateway.
- The adapter never fakes a TRAWL result and never silently downgrades:
  failover is a typed routing decision disclosed in every response.
- Caller-supplied credentials (headers, bodies) are explicit per-call arguments;
  the worker has no cookie jar and never forwards Sites identity.
- Probe/failure state is per-isolate and self-healing; a dead TRAWL endpoint
  degrades to the guarded stack within one probe timeout (4s).

## Known limitations

- Raw TCP on port 53 is intercepted by the Cloudflare edge (DNS-over-TCP tool is
  demonstrative; DNS resolution uses DoH).
- Worker `fetch` cannot shape the TLS handshake (no JA3 control) — that is what
  the TRAWL browser tier provides.
- Plain-HTTP targets route directly to fallback (the browser tier is
  HTTPS-only in practice).
- The connector caches the tool list per ChatGPT session; use a fresh chat
  after deploying new tools.

## License

MIT — see [LICENSE](LICENSE).
