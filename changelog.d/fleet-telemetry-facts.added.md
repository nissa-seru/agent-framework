- The facts a host's fleet telemetry reads are on the trace:
  - **The vocabularies, as data.** `TRACE_EVENT_TYPES` lists every trace
    type, and `OPS_ALERT_KINDS` (`OpsAlertKind`) the `ops:alert` kinds the
    framework raises itself, its bundled workspace module's included. The list and the `TraceEvent` union are checked
    against each other at compile time, both ways, and the framework's own
    alerts take their kind from `OpsAlertKind`. The union now declares the 25
    types the gate, the MCPL channel registry and push handler, checkpoints,
    the inference router and the tune-out coordinator already emitted outside
    it: `gate:policy-added`, `gate:policy-removed`, `gate:config-reconciled`,
    `gate:shadow-warnings`, `mcpl:channels-register`,
    `mcpl:channel-descriptor-rejected`, `mcpl:channels-changed`,
    `mcpl:channels-incoming`, `mcpl:channel-lazy-registered`,
    `mcpl:channel-reconcile-failed`, `mcpl:channel-open-substituted`,
    `mcpl:channel-reconcile-skipped`, `mcpl:channel-opened-by-send`,
    `mcpl:channel-open-failed`, `mcpl:state_registered`,
    `mcpl:checkpoint_recorded`, `mcpl:state_rollback`, `mcpl:inference_start`,
    `mcpl:inference_complete`, `mcpl:inference_fail`, `mcpl:push_event`,
    `tune-out:entered`, `tune-out:cancelled`, `tune-out:timer-failed` and
    `tune-out:ack-failed`, each with its fields. `EmittedTraceEvent`, an event
    as its emitter hands it (`timestamp` optional), is what the framework's
    emit and its components' trace hooks take, so an event the union doesn't
    declare, or a field written in the event that its entry doesn't, doesn't
    compile.
  - **The logical turn.** A turn's events carry `turnId` (`TurnTraced`):
    `inference:started`, `inference:request`, `inference:tokens`,
    `inference:content_block`, `inference:tool_calls_yielded`,
    `inference:usage`, `inference:stream_resumed`,
    `inference:stream_restarted`, `inference:published`,
    `inference:published_complete`, `inference:completed`,
    `inference:aborted`, `inference:failed`, `inference:exhausted`,
    `inference:turn_ended`, `tool:started`, `tool:completed`, `tool:failed`,
    `module:batch_hook_failed`, `prose:drafts-held`, `prose:draft-resent` and
    `prose:drafts-dismissed`. Every stream of a turn shares it (a budget
    restart's, a tool-result guard's retry, a held turn's later start), a
    later turn's is larger, and ids start again with the process. A tool
    call's events carry the turn the call was made in
    (`ToolCall.callerTurnId`), which a script's call can outlive, and its
    `agentName`. `mcpl:speech-routed`, `mcpl:speech-route-failed`,
    `gate:wake-line-omitted` and `tool:result_dropped` carry no turn.
  - **A turn's requests.** `inference:request` is traced once per membrane
    call a turn makes, after its compile and just before the stream sends
    it, with its `requestId`: the id the inference log's entry for the stream
    names, which the call also gives membrane as its `requestId` option
    (`ActivationRequestOptions.requestId`, new); membrane 0.7.1 doesn't
    record it. `inference:completed` carries the final response's
    `stopReason`, `refusal` among them, and none for a turn a tool's result
    ended.
  - **Addressed messages.** `message:addressed` names a message stored, or
    held for storage, with a wake asked for it, and an agent it waits to
    reach: each agent woken whose window holds it, every reader of the
    residents' shared slot among them. It covers an inbound message or push
    the gate wakes for at once or in a debounce batch (whose end wakes every
    agent but the subconscious), or whose wake the gate's sleep suppressed; a
    channel fork's message the router wakes it for, or a debounce batch
    holds, and a correction delivered to a fork; a coalesced render placed
    in an agent's deferred queue; a tune-out's diverted message, to the
    subconscious; a message a module's response adds with a wake, such as
    console or API input; and a notice the framework writes with its own
    wake (a self-wake's, a prose bounce's, a script's, a conversation's
    closure prompt, an autoContinue row, and the tune-out coordinator's wake
    notices, backlog dump and cancel report). `held` says it waits under the
    gate's sleep or the host's quiesce. It ends at the first
    `inference:request` or `inference:stream_resumed` of its agent whose new
    `delivered` names it (a tool boundary delivers only where the stream
    declares it carries injected messages), with the form it first reached
    the agent in (`AddressedDelivery`): `whole` where the request carries
    its stored body, and `summary` where it carries only a summary that
    covers it, read through `ContextManager.getSummary`. Or it ends at
    `message:withdrawn`, whose
    `reason` is `removed` (by its sender, RFC-006, or by a module),
    `agent-gone`, `branch-moved` (as after an undo) or `dropped` (a held
    write never stored, or a message every request drops, its text all
    blank). The framework keeps the waiting ones in memory, at most 1,000 per
    agent; past that a message's `message:addressed` is `untracked`, said
    each time its wake is asked.
    `message:added` gains the `agentName` whose window holds the message,
    which every emit must name (`undefined` where no agent does) and, for a
    write deferred at arrival, its `deferredId`, which `message:addressed`
    names it by.
  - **Holds.** `gate:decision`'s `sleep:set` carries `until`, and a sleep
    the `wake` tool, or a host's `EventGate.clearSleep()`, ends early is
    traced as `sleep:cleared`. `gate:decision` declares `observed`, the
    passthrough rules that matched and counted an event without firing,
    which the gate already sent. `GateDecision.heldBy` is `'sleep'` when the
    gate's sleep suppressed an event's wake and holds it: unless the rule
    that matches it in the policy table, read without side effects
    (`EventGate.probe`), is a `defer` or a `skip`. A rate limit or a sample
    that matches is held whatever its state, which the sleep doesn't spend
    (a passthrough one is peeked, as `probe` does, to tell whether the rule
    after it matches), and every event is held while a gate.js that loaded,
    in a worker still running, would decide. An inbound message's or push's
    `wakeLater` (`McplPushEvent`, `McplChannelIncomingEvent`) says the gate
    holds its wake rather than waking its agent now, in a debounce batch or
    under its sleep, and `ChannelRegistry`'s `shouldTriggerInference` may
    answer so, as the framework's gate does.
  - `StartStreamResult.carried` lists the stored bodies a request carries,
    as its compile's provenance names them, whole or in part; `dropped`
    those it doesn't, since it drops every message carrying them; and
    `summaries` the ids of the summaries it carries.
