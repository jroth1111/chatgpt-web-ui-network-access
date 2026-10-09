# 2.7.21

- Persist endpoint cooldowns, redacted failure aggregates and authentication
  stop latches in a separate private D1 binding, UPSTREAM_STATE. Transactional
  incident/health writes, sequence-fenced outcomes, and an expiring probe lease
  coordinate new Worker instances without deleting existing history.
- Require the binding for configured MCP scraping; missing/unavailable state
  fails explicitly, not silently as an in-memory durability guarantee.
- Capture bounded fixed-class upstream error evidence at runtime using existing
  operator credentials. Raw errors, URLs, cookies, tokens and lease handles are
  not exposed or persisted. Opaque 500 causes remain unknown pending live proof.
- Include schema migrations in the deployment artifact and build identity.
- Add SQLite and two-independent-workerd/D1 persistence, race, crash/rollback,
  auth-latch, missing-binding and diagnostic-redaction regressions.

# 2.7.20

- Repair DNS-over-TCP: fixed non-Cloudflare resolver, clear transport and no
  premature half-close; validate the length frame, transaction, question and
  answer ownership. Empty/malformed replies are not DNS success.
- Keep legacy FlareSolverr `/v1` compatibility without claiming its responses
  prove browser rendering. Optional `render: true` uses native TRAWL `/scrape`
  with `skipHttp` and a grounded `ready_selector`, requiring a reported browser
  tier and matching content. Unsupported/missing-render results fail explicitly.
- Isolate explicit Curl/Node target DNS errors only when the requested hostname
  matches; opaque service/proxy errors still degrade endpoint availability.
- Add synthetic DNS and render-provenance regression checks. These checks do
  not establish live upstream support or universal website reachability.

# 2.7.19

- Reconcile the public worker with the deployed 2.7.18 compatibility fixes:
  breaker state retention, request-error isolation, typed batch routing, empty
  batch validation and text-only output-budget shrinking.
- Bound both fetch and body reads independently of transport cancellation.
  Pre-aborted callers never reach transport. Cancellation does not poison
  endpoint health. Explicit target DNS/browser errors in 500 solve envelopes
  stay isolated; opaque service errors still degrade endpoint availability.
- Return complete HTML UTF8 byte counts and SHA256 with a clear hash scope.
  Suppress credential headers and raw transport exception text in diagnostics.
- Read owner/origin from private runtime bindings and fail closed if missing.
  Do not bake personal identities or deployment hosts into public source.
- Add the missing tracked MCP test entry, LinkeDOM dependency, lockfile and
  build-first test workflow. Generate content-based build identity and bake a
  source commit only from a clean worker closure.
- Add privacy and cancellation regression checks. Unit/fixture tests are not
  evidence that any particular live website is reachable.
