- **Hosts that build their own `EventGate` and handle `requestInference`:**
  `WakeProvenance.line` is now `lines`, a `WakeLine` per event of the batch;
  `WakeLine.shown` is absent for a quoted event; and `wakeLineText` takes the
  lines (`wakeLineText(lines, now)`). Migration: pass `provenance.lines` on as
  the request's `wakeLines`, with `readsWakeLines: true` so the wake is
  dropped once the agent has answered its batch, and render with
  `wakeLineText(lines, now)`.
  Unchanged: a host that gives the gate no `isNewestEntry` still has every
  batched wake's line written when the batch fires.
