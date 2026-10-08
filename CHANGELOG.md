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
