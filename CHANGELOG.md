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
