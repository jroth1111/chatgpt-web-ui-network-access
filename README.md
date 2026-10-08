# Network access tools for ChatGPT web UI

A self-hosted MCP backend giving a ChatGPT conversation **unrestricted owner-directed
network access**: arbitrary HTTP fetch (any method, caller headers, bodies), raw TCP
sockets, outbound WebSockets, and browser-grade scraping with challenge solving —
plus a full guarded public-read stack with DNS admission.

Deploy your own instance and connect it to your ChatGPT account. This repository
contains the application source — not a hosted public service.

## What runs where

```text
┌─────────────────────────────────────────────────────────────────────┐
│ 1. ChatGPT web UI — the MCP CLIENT (the "plugin"/connector)          │
│                                                                      │
│  • Discovers tools via MCP tools/list; invokes them via tools/call   │
│  • Renders results into the model's context                          │
│  • Runs user-selected models (GPT-6.1 Sol etc.) — NOT your code      │
│  • Caches the tool list per conversation session                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ managed OAuth via the Sites gateway
                               │ HTTPS POST https://your-site/mcp
┌──────────────────────────────▼──────────────────────────────────────┐
│ 2. ChatGPT Sites worker — the MCP SERVER (this repository's source)  │
│                                                                      │
│  • Implements the MCP protocol endpoint at /mcp (JSON-RPC)           │
│  • Owner identity comes from the Sites dispatch gateway headers —    │
│    caller-supplied identity headers are stripped before they arrive  │
│  • Runs 16 tools inside Cloudflare Workers isolates:                 │
│     – QuickJS WASM + LinkeDOM for page script execution              │
│     – guarded public reads (DNS admission, quality gates)            │
│     – browser_open_fetch: unrestricted HTTP(S) via platform fetch    │
│     – edge tools: raw TCP via cloudflare:sockets, WebSockets         │
│  • Holds probe/breaker availability state — per-isolate, ephemeral   │
│  • NO browser/Chromium here; no filesystem; no persistent cookies    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ one HTTPS POST → /v1 or /scrape (Basic auth)
                               │ only when browser_scrape is invoked
┌──────────────────────────────▼──────────────────────────────────────┐
│ 3. Your VPS — browser-grade scraping endpoint (optional)             │
│                                                                      │
│  • TRAWL may serve HTTP or escalate through browser tiers           │
│    /v1 does not identify the tier; native /scrape does                │
│  • Sessions persist in Redis on the VPS — never in the Sites worker  │
│  • Hardened: read-only containers, dropped capabilities, non-root    │
│  • Stateless from the worker's perspective: one POST per scrape      │
│  • If down → browser_scrape returns route:"fallback" and the         │
│    caller may explicitly choose the guarded worker path instead      │
└─────────────────────────────────────────────────────────────────────┘
```

**What does NOT run where:** no Chromium/browser in the Sites worker (page
execution is QuickJS approximation); no arbitrary code execution on the VPS
beyond TRAWL's own scraping engine. Open-fetch credentials come only from
explicit caller arguments; Sites identity/OAuth is never forwarded. The optional
scraper uses its separate private operator binding, not caller or Sites identity.

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
| `browser_edge_dns_tcp` | Validated DNS A reply from fixed 8.8.8.8:53; clear TCP, no DNSSEC/reachability claim |
| `browser_scrape` | Operator retrieval; optional native render-only mode, readiness check and explicit provenance/failover |
| `browser_scrape_batch` | Parallel 2–10 URL scrape, 4-way concurrency, per-item isolation |

## Highlights

- **Explicit rendering:** legacy `/v1` can serve a plain-HTTP tier. A route label,
  Chrome-like user agent or HTTP 200 does not prove JavaScript execution. Use
  `browser_scrape` with `render: true` and a CSS `ready_selector` grounded in the
  page, for example `.quote` on a known quote listing. This requires the native
  TRAWL `/scrape` contract (`skipHttp`, `contentWaitForSelector`). The adapter
  checks a reported browser tier and selector matches in the complete returned
  HTML, discloses `render_evidence`, and fails explicitly if unsupported or
  missing. This is not independent engine, screenshot or layout verification.
  Existing FlareSolverr-compatible deployments keep their legacy default.

- **Readability extraction**: `browser_scrape` returns cleaned text/title/links
  server-side (22KB cap) — the model sees content, not truncated HTML.
- **SPA/login-shell detection**: results flag `app_shell_suspected` with reasons
  (SPA mount nodes, low visible text, login screens). Detection does not reroute
  automatically: callers must explicitly request native `render: true` when
  rendered content is needed, and still inspect readiness/content evidence.
- **Circuit breaker**: consecutive probe timeouts widen cooldown exponentially
  (60s→240s, capped); healthy responses reset it. Recognized target solve errors
  and caller aborts do not poison health. Opaque upstream 500/proxy/service
  errors still trigger an isolate-local cooldown; a successful call in another
  isolate does not establish that the failed isolate remained healthy.
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
npm ci
npm test                # build, workerd, adapter, regression and privacy checks
npm run build           # dist/server/index.js + quickjs.wasm
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
   | `ORIGIN` | The existing Site HTTPS origin, without a path |
   | `PROJECT_ID` | (optional) Native Site project identity for provenance |
   | `TRAWL_URL` | (optional) Your TRAWL endpoint base URL for `browser_scrape` |
   | `TRAWL_TOKEN` | (optional) Basic-auth password for that endpoint |

   Without `TRAWL_URL`, `browser_scrape` returns `route:"fallback"` with
   `trawl_not_configured` — the other 15 tools work regardless.

   Owner and origin bindings are required and read at runtime. Missing values
   fail closed. Do not replace private values with public-template placeholders
   in an existing deployment, or embed those values in committed source.

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
- A listed tool or successful build is not live Internet acceptance. Platform
  restrictions and target denials remain possible; verify returned content,
  source URL, complete-body hash and explicit truncation fields.

## License

MIT — see [LICENSE](LICENSE).
