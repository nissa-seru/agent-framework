- **Hosts that build their own `EventGate` and handle `requestInference`:**
  `WakeProvenance.line` is now `lines`, a `WakeLine` per event of the batch;
  `WakeLine.shown` is absent for a quoted event; and `wakeLineText` takes the
  lines (`wakeLineText(lines, now)`). Migration: pass `provenance.lines` on as
  the request's `wakeLines`, and render with `wakeLineText(lines, now)`. For
  the wake to be dropped once the agent has answered its batch, the request
  also needs `readsWakeLines: true`, and the host passes each event's write
  to `evaluate` (`after`, in `.added`); the gate hands lines only to a host
  with `isNewestEntry`.
  Unchanged: a host that gives the gate no `isNewestEntry` still has every
  batched wake's line written when the batch fires.
