- `EventGate.evaluate(info, after)` takes where the host put the event's own
  message (`WritePlacement`), as the gate's `addMessage` and
  `requestInference` hooks take `placement` and `after`, so that a batched
  wake can be dropped once the agent has answered it. `WakeLine` gains
  `content` (a quoted event's text), `after` and `replyTo`, and
  `InferenceRequest.readsWakeLines` marks a wake whose sole cause is the batch
  its lines name.
