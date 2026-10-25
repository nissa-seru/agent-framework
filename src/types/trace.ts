import type { ThinkingBindingEntry } from '@animalabs/membrane';
import type { ProcessEvent } from './events.js';
import type { ModuleProcessResponse } from './framework.js';
import type { SessionUsage } from '../usage/types.js';
import type { DraftReason } from '../prose-drafts.js';
import type { RecipeChanges } from '../gate/recipe-reconcile.js';
import type { PushEventResult } from '../mcpl/types.js';

/**
 * Base for all trace events.
 * TraceEvents are observability-only — they NEVER drive logic.
 */
export interface TraceEventBase {
  /** When this trace was emitted */
  timestamp: number;
  /** Optional correlation ID for distributed tracing */
  traceId?: string;
}

/**
 * An addressed message's first delivery into its agent's provider input:
 * the id it was addressed under, and its form, `whole` where the request
 * carries its stored body raw, whole or in part, and `summary` where it
 * carries only a summary that covers it. The first form stands: the message
 * leaves the record at its first delivery.
 */
export interface AddressedDelivery {
  messageId: string;
  form: 'whole' | 'summary';
}

/**
 * The logical turn a trace event belongs to (fleet telemetry reads a turn's
 * events by it). Every stream of a turn shares the id: a budget restart's, a
 * tool-result guard's retry, and a held turn's later start included. Ids are
 * numbered as turns open, so an agent's later turn has a larger one, and
 * they start again when the process does. A tool call's events carry the turn
 * the call was made in (`ToolCall.callerTurnId`), which a script's call can
 * outlive; a call no turn made or watches, such as a script left running,
 * carries none.
 */
export interface TurnTraced {
  turnId?: number;
}

/**
 * Observability events emitted by the framework.
 * Subscribe via framework.onTrace() to monitor system behavior.
 *
 * These are purely informational — use them for:
 * - UI updates (showing inference progress, tool execution)
 * - Logging and debugging
 * - Metrics and monitoring
 * - Broadcasting to WebSocket clients
 *
 * They should NEVER be used to drive application logic.
 * For that, use ProcessEvent via the event queue.
 */
export type TraceEvent =
  // Process lifecycle
  | (TraceEventBase & { type: 'process:received'; processEvent: ProcessEvent })
  | (TraceEventBase & {
      type: 'process:completed';
      processEvent: ProcessEvent;
      /** The modules' responses that applied: one refused for malformed
       *  content is left out, and named by process:response-refused. */
      responses: ModuleProcessResponse[];
      durationMs: number;
    })
  /** A module's process response held content context-manager won't store,
   *  in a message it adds or an edit it makes, and was refused whole before
   *  any response to the event applied. `where` names the first such message
   *  or edit in the response, such as `addMessages[1]`, and `places` is
   *  malformedContentPlaces' answer for it. */
  | (TraceEventBase & {
      type: 'process:response-refused';
      moduleName: string;
      eventType: string;
      where: string;
      places: string[];
    })

  // Inference lifecycle
  | (TraceEventBase & TurnTraced & {
      type: 'inference:started';
      agentName: string;
      /**
       * The turn's locus as this stream starts (locus and hybrid mode): where
       * its unprefixed plain prose is published, unless a hybrid `>>>`
       * destination takes it, or a re-pin or a `channel_open` moves the locus
       * later in the turn. Omitted for a turn with no locus: explicit and
       * disabled mode, a silent turn, and a heartbeat with no default
       * channel. Observability only, like every trace field; lets external
       * taps (e.g. a TTS relay) tag the whole activation with its channel
       * without re-deriving routing.
       */
      channelId?: string;
      /**
       * The server that registers `channelId`, given with it. Two MCPL
       * servers may register one channel id, so a tap that posts back to the
       * turn's channel, such as a host telling it the turn failed, passes this
       * server with the id. The streaming traces, `inference:tokens` and
       * `inference:content_block`, carry the id alone.
       */
      serverId?: string;
      /** True for a control-plane wake that must not surface typing/prose. */
      silent?: boolean;
    })
  | (TraceEventBase & TurnTraced & {
      /**
       * The model answered and the turn ended: with the stream's final
       * response, or with a tool result carrying `endTurn`, which
       * `inference:turn_ended` then follows. `tokenUsage` is the stream's
       * usage, cumulative across its rounds.
       */
      type: 'inference:completed';
      agentName: string;
      durationMs: number;
      tokenUsage?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
      /** The final response's stop reason (membrane's `stopReason`), such as
       *  `end_turn`, or `refusal` for a turn whose request was refused after
       *  membrane's own re-issues (`refusalRetries`). Absent for a turn a
       *  tool's result ended. A refusal's category isn't carried here. */
      stopReason?: string;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:aborted';
      agentName: string;
      /** How long this start of the turn ran; after a context-budget restart, from the restart. */
      durationMs: number;
      /**
       * Why the turn ended unfinished: the reason its canceller gave
       * `abortInference` or `Agent.cancelStream` (`'user'` when it gave
       * none), `'shutdown'` for a turn `stop()` cancelled,
       * `'quiesce_abandoned'` for a turn an operator quiesce abandoned, or,
       * for a turn dropped before it sent anything (its agent replaced or
       * removed, or the framework stopping or restarted), a sentence saying
       * which.
       */
      reason?: string;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:failed';
      agentName: string;
      /** The failure's message, bounded as every trace event's `error` is (2,000 characters). */
      error: string;
      /** Bounded like `error`. */
      stack?: string;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:exhausted';
      agentName: string;
      /** The failure's message, bounded as every trace event's `error` is (2,000 characters). */
      error: string;
      /** Whether membrane classified the failure as retryable (observability). */
      retryable?: boolean;
      /**
       * The membrane error type (e.g. 'invalid_request', 'auth', 'context_length'),
       * at most 128 characters. The poison-history breaker fires only on
       * 'invalid_request' at HTTP 400, 413 or 422 or with no status, and on
       * 'context_length' at 413 (shedMayHelp).
       */
      errorType?: string;
      /** The provider's HTTP status, when the failure carried one. */
      httpStatus?: number;
      /** The provider's own error code, when it sent one (at most 128 characters). */
      providerErrorCode?: string;
    })

  // Streaming inference lifecycle
  | (TraceEventBase & TurnTraced & {
      type: 'inference:tokens';
      agentName: string;
      content: string;
      /**
       * Which membrane block produced this chunk. Carried verbatim from the
       * membrane's ChunkMeta. Consumers that want to render thinking content
       * distinctly from regular text should switch on this.
       */
      blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
      /** 0-indexed block position in the current assistant turn. */
      blockIndex: number;
      /** The channel this stream shows typing in, the conversation the turn
       *  is attending. Locus and hybrid mode: the turn's locus, which an
       *  addressed re-pin or the agent's own `channel_open` can move between
       *  rounds, so it can change within one stream; the indicator and these
       *  traces follow it from the next round on, at the model's first
       *  content in it or its retry after a refusal, and a tool result the
       *  boundary reports carries the channel of the round it answers. In
       *  hybrid mode a `>>>` envelope can send the text itself elsewhere.
       *  Explicit mode: the channel its typing shows, where the start's wake
       *  came from, or, at a start whose wake names none, such as a budget
       *  restart, the one the turn already shows. */
      channelId?: string;
    })
  | (TraceEventBase & TurnTraced & {
      /**
       * Structural boundary inside the assistant turn — emitted on every
       * block_start / block_complete from the membrane. Use this to switch
       * render lanes (e.g. open a dim "thinking" element on block_start
       * with blockType='thinking', close it on block_complete).
       */
      type: 'inference:content_block';
      agentName: string;
      phase: 'block_start' | 'block_complete';
      blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
      blockIndex: number;
      /** The channel this stream shows typing in, the conversation the turn
       *  is attending. Locus and hybrid mode: the turn's locus, which an
       *  addressed re-pin or the agent's own `channel_open` can move between
       *  rounds, so it can change within one stream; the indicator and these
       *  traces follow it from the next round on, at the model's first
       *  content in it or its retry after a refusal, and a tool result the
       *  boundary reports carries the channel of the round it answers. In
       *  hybrid mode a `>>>` envelope can send the text itself elsewhere.
       *  Explicit mode: the channel its typing shows, where the start's wake
       *  came from, or, at a start whose wake names none, such as a budget
       *  restart, the one the turn already shows. */
      channelId?: string;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:tool_calls_yielded';
      agentName: string;
      calls: Array<{ id: string; name: string; input?: unknown }>;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:usage';
      agentName: string;
      tokenUsage: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
      /**
       * The provider's report on the signed thinking of the call this event
       * closes (membrane's `RoundReport.thinking`): blocks it dropped before
       * the model saw them, and blocks it showed the model anyway because the
       * check isn't enforced. `tokenUsage` beside it is the stream's running
       * total, not this call's. The provider reports them for a request that
       * carried the binding control, whoever asked for it:
       * `thinkingBinding.dropBlock`, or a thinking config the host sends
       * itself. Present only when the report names any block.
       */
      thinking?: {
        dropped: ThinkingBindingEntry[];
        mismatchAllowed: ThinkingBindingEntry[];
      };
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:stream_resumed';
      agentName: string;
      /** Count of mid-turn messages injected into the resumed round (hear-while-acting). */
      injectedMessages?: number;
      /** The addressed messages (`message:addressed`) this round's request
       *  carries to the agent for the first time, injected here, each by the
       *  id it was addressed under, `whole`. Only a stream that declares it
       *  carries injected messages delivers them here; otherwise the next
       *  compile does. Absent when none. */
      delivered?: AddressedDelivery[];
    })
  /**
   * A request a turn sends, once its compile is done and just before the
   * stream sends it: one per membrane call (a stream's later rounds are
   * `inference:stream_resumed`). `requestId` is the id the call gives
   * membrane as its `requestId` option, and the inference log's entry for
   * the stream names it too.
   */
  | (TraceEventBase & TurnTraced & {
      type: 'inference:request';
      agentName: string;
      requestId: string;
      /** The addressed messages (`message:addressed`) this request carries
       *  to the agent for the first time, each by the id it was addressed
       *  under, with the form it first reached the agent in. Absent when
       *  none. */
      delivered?: AddressedDelivery[];
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:stream_restarted';
      agentName: string;
      reason: string;
      inputTokens: number;
      budget: number;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'inference:turn_ended';
      agentName: string;
    })
  | (TraceEventBase & TurnTraced & {
      /**
       * Prose that delivery published, sent once the publish succeeds: the
       * outgoing stream's chunk (MCPL Spec 14.3 `channels/outgoing/chunk`),
       * emitted whether or not the channel's server takes the stream. It
       * carries only what was published, so a consumer that speaks or shows
       * it, such as a voice relay, never gets text that delivery withholds (a
       * `skip_reply`, a silencing send, a private `think`, a hold, a bounce,
       * a draft) or a publish the server didn't confirm (`delivered: true`):
       * one refused before sending, one that threw, timed out or got an
       * error answer, one the server reported undelivered
       * (`delivered: false`), and one whose reply leaves `delivered` out.
       * `inference:tokens` stays the model's text as it is written (held, as
       * before, while a tool-result guard's batch is pending). A later
       * publish to the same destination, a server and its channel, by the
       * same stream opens with a paragraph break (`\n\n`), so a
       * destination's chunks joined in `index` order are its text, its
       * messages kept apart.
       * `mcpl:speech-routed` also reports speech publishes, with no stream
       * id, index or end, each once delivered: deliverSpeech's, the `sleep`
       * tool's announcement among them, and a subconscious's
       * `speak_in_channel`'s. A relay that voices the agent's prose takes
       * this trace, with `inference:published_complete`, and not
       * `mcpl:speech-routed` as well, and takes each message's id from its
       * `messageId` to edit what it voiced.
       */
      type: 'inference:published';
      agentName: string;
      /** The server the prose is published to, and its channel there: two
       *  servers' channels with the same id are two destinations. */
      serverId: string;
      channelId: string;
      /** The stream's id, shared with its `channels/outgoing/*` notifications. */
      inferenceId: string;
      /** Increases by one per chunk of the stream, across its channels. */
      index: number;
      text: string;
      /** The id the channel's server returned for this chunk's publish
       *  (`ChannelsPublishResult.messageId`); absent when it returned none.
       *  Each chunk is one publish, so each carries its own. */
      messageId?: string;
    })
  | (TraceEventBase & TurnTraced & {
      /**
       * A stream's end for one destination it published to, a server and
       * its channel, emitted on every exit path once the stream has ended
       * and its deliveries have run, or, when the host stops, before its
       * connections close: `text` is everything its `inference:published`
       * chunks carried there by then, and none follows it. Like those
       * chunks, it's emitted whether or not that server takes the stream,
       * or registers the channel still; the MCPL
       * `channels/outgoing/complete` goes to the server only when it does.
       */
      type: 'inference:published_complete';
      agentName: string;
      serverId: string;
      channelId: string;
      inferenceId: string;
      text: string;
    })

  // Tool lifecycle
  | (TraceEventBase & TurnTraced & {
      type: 'tool:started';
      /** The agent whose call it is; absent for a call no agent made. */
      agentName?: string;
      module: string;
      tool: string;
      callId: string;
      input?: unknown;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'tool:completed';
      /** The agent whose call it is; absent for a call no agent made. */
      agentName?: string;
      module: string;
      tool: string;
      callId: string;
      durationMs: number;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'tool:failed';
      /** The agent whose call it is; absent for a call no agent made. */
      agentName?: string;
      module: string;
      tool: string;
      callId: string;
      error: string;
      stack?: string;
      /** How long the call ran, where its path measures it. */
      durationMs?: number;
    })
  | (TraceEventBase & {
      type: 'tool:result_dropped';
      agentName: string;
      callId: string;
      agentStatus: string;
      result: unknown;
    })
  | (TraceEventBase & TurnTraced & {
      /**
       * A module's onToolBatchComplete threw or outlasted its bound; the
       * round went on without it.
       */
      type: 'module:batch_hook_failed';
      agentName: string;
      module: string;
      error: string;
    })
  | (TraceEventBase & {
      /**
       * The workspace had a writable mount without an include, where spills
       * go, but the oversized-result spill write failed (size cap, storeBlob failure, …) — the over-cap tail was NOT
       * retained. Distinct from the no-workspace fallback, which is silent
       * by design (nothing unexpected happened), whether the setup has no
       * writable mount or every writable mount has an include, as configured.
       */
      type: 'tool:spill_failed';
      label: string;
      path: string;
      contentLength: number;
      error: string;
    })

  // Module lifecycle
  | (TraceEventBase & { type: 'module:added'; moduleName: string })
  | (TraceEventBase & { type: 'module:removed'; moduleName: string })

  // Inference request health
  | (TraceEventBase & {
      type: 'inference:request_dropped';
      agentName: string;
      reason: string;
      requestCount: number;
      oldestRequestAge: number;
    })
  | (TraceEventBase & {
      type: 'inference:request_stale';
      agentName: string;
      agentStatus: string;
      requestCount: number;
      oldestRequestAge: number;
    })

  // Message lifecycle
  | (TraceEventBase & {
      type: 'message:added';
      /** The stored message's id; `''` for a write deferred at arrival (a
       *  turn of its agent's alive, a quiesce), which `deferredId` names. */
      messageId: string;
      source: string;
      /** The agent whose window it was stored in, or is held for. */
      agentName?: string;
      /** A write deferred at arrival: its id in the deferred queue. */
      deferredId?: string;
    })
  /**
   * A message stored, or held for storage, with a wake asked for it, so it
   * waits to reach its agent's provider input (fleet telemetry's addressed
   * message): an inbound message or push the gate wakes for at once or in a
   * debounce batch, or whose wake the gate's sleep suppressed; console or
   * API input, or a module's message its response adds with a wake; or a
   * framework notice written with its own wake: a self-wake's, a prose
   * bounce's, a script's, a conversation's closure prompt, an autoContinue
   * row, and the tune-out coordinator's notices. It's addressed to each
   * agent woken whose window holds it, every reader of the residents' shared
   * slot among them. `messageId` is the id its `message:added` named (its
   * `deferredId` for a write deferred at arrival). It ends at the first `inference:request` or
   * `inference:stream_resumed` of that agent's whose `delivered` names it,
   * or at its `message:withdrawn`. The framework keeps the waiting ones in
   * memory, so a restart ends them unseen.
   */
  | (TraceEventBase & {
      type: 'message:addressed';
      messageId: string;
      agentName: string;
      /** Held for a recorded reason until the hold ends: `sleep`, the gate's
       *  sleep (`gate:decision` `sleep:set` to its end), or `quiesce`, the
       *  host's (`host:quiesce` to `host:resume`). */
      held?: 'sleep' | 'quiesce';
      /** The agent's record of waiting messages was full, so no
       *  `delivered` or `message:withdrawn` will name this one, and a wake
       *  asked for it again is said again, since nothing past the bound is
       *  remembered. */
      untracked?: true;
    })
  /** An addressed message (`message:addressed`) that won't reach its
   *  agent's provider input: `removed` (by its sender, RFC-006, or by a
   *  module), its agent gone (`agent-gone`), no longer on the agent's
   *  branch (`branch-moved`, as after an undo), or `dropped`: a held write
   *  that was never stored, or a message every request drops, left with
   *  nothing once its empty text is stripped. */
  | (TraceEventBase & {
      type: 'message:withdrawn';
      messageId: string;
      agentName: string;
      reason: 'removed' | 'agent-gone' | 'branch-moved' | 'dropped';
    })
  /** An unread message withdrawn or replaced by its sender (RFC-006). */
  | (TraceEventBase & {
      type: 'message:removed';
      messageId: string;
      source: string;
    })
  /** A push/event refused at the MCPL boundary: visibly-empty content
   *  (`empty-content`, answered -32602, with no `field` or `detail`), or a
   *  coalesced occurrence the host refused. A refused occurrence's reason
   *  follows the code the producer was answered with: `coalesce-invalid` when
   *  the occurrence was the producer's to fix (-32602 malformed; -32017 or
   *  -32023 for a channel not permitted or not registered), `coalesce-failed`
   *  when the host itself failed (-32000, -32603). Its trace carries the
   *  error's message in `detail`, and the failing `field` when the error
   *  names one, and `channelId` when the push is refused for its channel
   *  (-32017, -32023), so each refusal names its channel even while repeats
   *  of its line are held back. An `eventId` that is missing or isn't a
   *  string is traced as `''`. A push refused for its feature set, or as a
   *  duplicate, gets a `[push-event-rejected]` line and no trace. */
  | (TraceEventBase & {
      type: 'mcpl:push-event-rejected';
      serverId: string;
      eventId: string;
      featureSet: string;
      reason: string;
      field?: string;
      channelId?: string;
      detail?: string;
    })
  /** A channels/incoming message refused at the MCPL boundary: an
   *  unregistered channel (`unknown-channel`, §14.5), visibly-empty content
   *  (`empty-content`), or a coalesced item the host refused
   *  (`coalesce-invalid` / `coalesce-failed`, with `detail`, and `field` when
   *  the error names one, as for a push). A coalesced item refused with
   *  -32602 (malformed) is answered `coalesce_invalid`, and one refused
   *  otherwise (-32000, or an internal error) with the error's own message.
   *  `messageId` is set whenever the message carries one. An uncoalesced
   *  message without a channelId or messageId is answered `invalid
   *  channel/message identity`, with no line and no trace. */
  | (TraceEventBase & {
      type: 'mcpl:channel-incoming-rejected';
      serverId: string;
      channelId: string;
      messageId?: string;
      reason: string;
      field?: string;
      detail?: string;
    })
  /** MCPL content that context-manager won't store, because it doesn't
   *  match ContentBlock, reached the store/wake site and was refused there:
   *  no row, no wake. `places` is malformedContentPlaces' answer for it. */
  | (TraceEventBase & {
      type: 'mcpl:malformed-content-refused';
      lane: 'push' | 'channel';
      serverId: string;
      places: string[];
      eventId?: string;
      channelId?: string;
      messageId?: string;
    })
  /** MCPL content with nothing model-visible reached the store/wake site
   *  (module-emitted or coalescer-delivered) and was dropped: no row, no wake. */
  | (TraceEventBase & {
      type: 'mcpl:empty-content-dropped';
      lane: 'push' | 'channel';
      serverId: string;
      eventId?: string;
      channelId?: string;
      messageId?: string;
    })
  /** RFC-006 coalescing decision record (received / displaced / removed /
   *  rendered / revoked / render-cancelled / late-render / render-failed).
   *  A late-render whose push/render had already timed out, its fallback
   *  materialized, is recorded by the connection's wiring rather than the
   *  coalescer: it names `serverId`, `featureSet`, `key` and, for a
   *  channel-scoped subject, `channelId` instead of `subject`, carries a late
   *  JSON-RPC error as `error` (`[code] message`, bounded), and its `eventId`
   *  links it to the batch's render-failed. */
  | (TraceEventBase & {
      type: 'mcpl:coalescing';
      kind: string;
      subject?: string;
      eventId?: string;
      [key: string]: unknown;
    })

  // EventGate lifecycle
  | (TraceEventBase & {
      type: 'gate:policy-matched';
      policyName: string;
      behavior: string;
      eventType: string;
      source?: string;
    })
  | (TraceEventBase & {
      type: 'gate:config-error';
      error: string;
      configPath: string;
    })
  | (TraceEventBase & {
      type: 'gate:debounce-delivered';
      policyName: string;
      eventCount: number;
    })
  | (TraceEventBase & {
      /** A batched wake's turn started without its `[Gate: …]` line (the
       *  gate hands the line to the wake when its message is the newest at
       *  the fire, EventGate isNewestEntry, and the turn's start decides).
       *  `reason`: `newest`, on the delivery agent's start the message was
       *  still the newest entry in the window; `held`, the host was quiesced
       *  or another reader of the residents' shared slot had a turn alive,
       *  so no line could be written then. */
      type: 'gate:wake-line-omitted';
      reason: 'newest' | 'held';
      policyNames: string[];
      eventType: string;
      channelId?: string;
    })
  | (TraceEventBase & {
      type: 'gate:config-reloaded';
      configPath: string;
      policyCount: number;
      /** Rules the reload left out, which lost their state; absent when none. */
      removedPolicies?: string[];
      /** Rules kept under another behavior, whose state the reload cleared;
       *  absent when none. */
      stateClearedPolicies?: string[];
    })
  | (TraceEventBase & {
      type: 'gate:decision';
      /** The event's type, or one of the gate's own, such as `sleep:set` and a
       *  sleep's end: `sleep:expired` at its time, or `sleep:cleared` when
       *  `wake` ends it early. */
      eventType: string;
      serverId?: string;
      channelId?: string;
      matchedPolicy: string | null;
      trigger: boolean;
      behavior: string;
      /** For `sleep:set`: when the sleep is due to end (epoch ms). */
      until?: number;
      /** Passthrough policies that matched and counted the event without
       *  firing (GateDecision.observed); absent when none. */
      observed?: string[];
    })
  /** A policy was written to gate.json: added, or `replaced` one of its name. */
  | (TraceEventBase & {
      type: 'gate:policy-added';
      configPath: string;
      policyName: string;
      replaced: boolean;
    })
  /** A policy was removed from gate.json by name. */
  | (TraceEventBase & {
      type: 'gate:policy-removed';
      configPath: string;
      policyName: string;
    })
  /** A start merged the host's recipe into gate.json: what it changed, by
   *  rule name (RecipeChanges), and `addedPolicies`, every name it added. */
  | (TraceEventBase & RecipeChanges & {
      type: 'gate:config-reconciled';
      configPath: string;
      addedPolicies: string[];
    })
  /** The set of rules an earlier rule shadows changed and isn't empty: each
   *  warning formatted as the gate's status shows it. */
  | (TraceEventBase & {
      type: 'gate:shadow-warnings';
      reason: string;
      warnings: string[];
    })

  // Usage lifecycle
  | (TraceEventBase & {
      type: 'usage:updated';
      totals: SessionUsage;
      agentName: string;
      inferenceCount: number;
    })

  // Undo/redo lifecycle
  | (TraceEventBase & {
      type: 'undo:completed';
      agentName: string;
      turnIndex: number;
      fromBranch: string;
      toBranch: string;
    })
  | (TraceEventBase & {
      type: 'redo:completed';
      agentName: string;
      fromBranch: string;
      toBranch: string;
    })

  // Operator-initiated mutation (rollback/suppress/undo/hide/settings/quiesce…).
  // Mirrors the durable operator-actions.jsonl record so live UIs see the
  // same entry the file keeps.
  | (TraceEventBase & {
      type: 'operator:action';
      agentName?: string;
      kind: string;
      requester?: { via: string; name?: string; id?: string };
      note?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string;
    })

  // MCPL subprocess stderr (one trace per line, for receipts when things break)
  | (TraceEventBase & {
      type: 'mcpl:server-stderr';
      serverId: string;
      line: string;
    })

  // Per-channel conversation routing lifecycle
  | (TraceEventBase & {
      type: 'mcpl:conversation-spawned';
      channelId: string;
      /** The channel's server: a channel id is unique only within one server. */
      serverId: string;
      agentName: string;
      generation: number;
      template: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-spawn-failed';
      channelId: string;
      /** The channel's server: a channel id is unique only within one server. */
      serverId: string;
      agentName: string;
      error: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-unrouted';
      channelId: string;
      /** The channel's server: a channel id is unique only within one server. */
      serverId: string;
      messageId: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-binding-orphaned';
      channelId: string;
      /** The channel's server: a channel id is unique only within one server. */
      serverId: string;
      agentName: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-closed';
      channelId: string;
      /** The channel's server: a channel id is unique only within one server. */
      serverId: string;
      agentName: string;
      reason: 'idle-ttl';
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-disposed';
      agentName: string;
      channelId?: string;
      /** The home channel's server, beside its channelId. */
      serverId?: string;
    })

  // Host-owned speech routing (ChannelRegistry.routeSpeech). One trace per
  // delivered prose segment, and one per publish the subconscious's
  // speak_in_channel delivers (ChannelRegistry.publishForAgent): that one's
  // conversationId is the speaking agent's name, and it carries no
  // messageId. `text` is the segment verbatim — the same content
  // already on the bus chunk-by-chunk via inference:tokens, and mcpl:* traces
  // are 'ops'-scoped on the webui wire — and `messageId` is the surface's id
  // for the posted message (on routeSpeech's traces, when the MCPL server
  // reports one). Together they give external taps the (channelId,
  // messageId, text) tuple needed to edit a just-posted message, e.g. a TTS
  // interruption truncating a reply to the words actually voiced.
  | (TraceEventBase & {
      type: 'mcpl:speech-routed';
      /** Agent / conversation whose speech was routed. */
      conversationId: string;
      serverId: string;
      channelId: string;
      delivered: boolean;
      textLen: number;
      /** The routed prose segment, verbatim. */
      text: string;
      /** Surface message id (e.g. Discord message id), when reported, on
       *  routeSpeech's traces. speak_in_channel's carry none. */
      messageId?: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:speech-route-failed';
      /** Agent / conversation whose speech failed to route. */
      conversationId: string;
      /** The channel's server, where the destination, or the caller, named
       *  one: a channel id is unique only within one server. */
      serverId?: string;
      /** Empty string when the failure was "no locus at all". */
      channelId: string;
      reason: string;
      textLen: number;
      /** `failed`: nothing was posted; `unknown`: the request was dispatched
       *  and no valid receipt came back, so it may have been. */
      outcome?: 'failed' | 'unknown';
      /** The connector error's structured data, bounded (connectorText),
       *  when it sent some: it may say what a multi-part send posted. */
      detail?: string;
    })

  // Admin puppet: an operator executed a tool AS an agent and stored the
  // tool_use + tool_result pair in that agent's window (Framework.
  // puppetToolCall). Provenance lives HERE and in the host log — the stored
  // messages deliberately byte-match a model-initiated call.
  | (TraceEventBase & {
      type: 'puppet:tool-call';
      agentName: string;
      toolName: string;
      toolUseId: string;
      isError: boolean;
      durationMs: number;
      /** The pair was queued behind a turn that replaced the puppet's
       *  reservation (provider-admission re-entry) instead of stored
       *  directly; it lands at that turn's end flush. */
      deferred?: boolean;
    })

  // MCPL server connection lifecycle (spawn / handshake / reconnect health).
  // Previously these outcomes were visible only on the host process's own
  // stderr, so a server that lost the boot handshake race just went missing.
  | (TraceEventBase & {
      type: 'mcpl:server-connect-failed';
      serverId: string;
      error: string;
      /** The last of the server's stderr, when its handshake failed by its
       *  transport closing, a transport error or its timeout and it had
       *  written any: the server's own text, which `error` never carries. A
       *  transport that failed its handshake was never wired, so its lines
       *  never reached `mcpl:server-stderr`. */
      stderrTail?: string;
      /** Ordinal of the failed attempt: 0 is the initial connect, N is the Nth background retry. */
      attempt: number;
      /** True when a background reconnect loop will keep retrying. */
      willRetry: boolean;
    })
  | (TraceEventBase & {
      /** §17.6: the ONE normalized receipt per manifest change — closed
       *  host-derived impact vocabulary, never a server-authored flag. */
      type: 'mcpl:manifest-change-receipt';
      serverId: string;
      revision: string | null;
      announcedDomains: string[];
      impacts: Array<{ impact: string; subject: string; disposition: string }>;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-reconnected';
      serverId: string;
      /** How many attempts the reconnect loop needed (1 = first retry succeeded). */
      attempts: number;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-closed';
      serverId: string;
      /** Child process exit code, or null when killed by signal / closed explicitly. */
      code: number | null;
      /** Signal that terminated the child, if any. */
      signal: string | null;
      /** Why the transport closed, in its own words, such as `child process
       *  exited, and its pipe failed with write EPIPE` or `closed by host`;
       *  null when it gave none, or when its reason is a WebSocket server's
       *  own close text, which stays off the trace. */
      reason: string | null;
      /** True when a background reconnect loop will revive the connection. */
      willReconnect: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-error';
      serverId: string;
      error: string;
    })
  // Configuration that is accepted but silently does nothing. Each mirrors
  // a console line, so hosts that keep per-server logs from the trace bus
  // see it too.
  | (TraceEventBase & {
      /** §5.3/§6.7: the server refused the host's policy Request. */
      type: 'mcpl:policy-refused';
      serverId: string;
      /** The initial policy at connect, or the re-negotiation after a manifest change. */
      phase: 'initial' | 'manifest-change';
      reason: string | null;
      /** `close`: the host closed the connection. `mcp-only`: the grant
       *  stays empty and only plain MCP tools work. */
      fallback: 'close' | 'mcp-only';
    })
  | (TraceEventBase & {
      /** §6.4 derivation disabled a declared feature set. */
      type: 'mcpl:feature-set-disabled';
      serverId: string;
      featureSet: string;
      /** `invalid_uses`: `uses` absent, empty or unrecognized.
       *  `missing_capabilities`: `uses` names capabilities the grant lacks. */
      reason: 'invalid_uses' | 'missing_capabilities';
      /** True when config selected the set (enabledFeatureSets omitted or
       *  matching it, and not disabledFeatureSets): derivation overrode it. */
      selectedByConfig: boolean;
      /** invalid_uses: the unrecognized entries (empty when `uses` was absent or empty). */
      unrecognized?: string[];
      /** missing_capabilities: the capability paths the grant lacks. */
      missing?: string[];
    })
  | (TraceEventBase & {
      /** An operator tool-name pattern matches no model-facing tool. Emitted
       *  once per pattern, after the servers it could name have listed. */
      type: 'mcpl:tool-pattern-unmatched';
      /** `toolClassOverrides`, `toolLifecycle.observe.tools` or `toolLifecycle.inputs.tools`. */
      setting: string;
      /** The server whose toolLifecycle config holds the pattern. */
      serverId?: string;
      pattern: string;
      /** The pattern rewritten under the server's actual tool prefix. */
      suggestion?: string;
      hint: string;
    })
  | (TraceEventBase & {
      /** An inbound RPC request/notification handler failed: it threw or
       *  rejected, or it resolved after a reply write of its own failed or
       *  after it tried to answer a second time. */
      type: 'mcpl:request-handler-error';
      serverId: string;
      /** Connection event name, e.g. channels-register or push-event. */
      event: string;
      /** The request's id when it is a number, or a string id bounded as the
       *  other texts here are: control, format and line-separator characters
       *  replaced, and cut after 500 code points, with "…" marking the cut.
       *  Absent for a notification, for a request whose id is neither, and
       *  for a request form of mcpl/manifestChanged or
       *  notifications/tools/list_changed, which is answered as it's admitted
       *  and then handled as the notification is. */
      requestId?: string | number;
      /** Whether a reply write of the handler's returned: true once one
       *  did. On a connection that had already closed, that write dropped
       *  the reply, as the connection then drops every reply, so nothing
       *  reached the server. A write that throws, as one that can't be
       *  encoded does, sends nothing. When it's false and the responder
       *  can send an error reply (it has respondError), the host sent -32603
       *  "Internal error" itself, or -32000 while it stops, unless
       *  `responseError` says that reply failed. A connection that has
       *  already closed drops that reply, as it drops every reply, with no
       *  `responseError`. */
      responseAttempted: boolean;
      /** The handler's own error when it threw or rejected; otherwise the
       *  reply write that failed and that it swallowed, or that it tried to
       *  answer a second time. */
      error: string;
      /** A reply write that failed, when the handler then failed with an
       *  error of its own (which is `error`). */
      responseFailure?: string;
      /** What the handler tried to send after a reply was already attempted:
       *  refused, never written. A result, or an error reply with its code
       *  and (bounded) message. */
      refusedResponse?: { kind: 'result' } | { kind: 'error'; code: number; message: string };
      /** Failure while trying to send the internal-error response. */
      responseError?: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:orphaned-response';
      serverId: string;
      /** The JSON-RPC id of the late response, whose request had already timed out or been ended by its transport's close. */
      responseId: string | number;
      /** Original request method when retained for mandatory-deadline visibility. */
      method?: string;
      /** True when the dropped response carried host-managed `state`. */
      hadState: boolean;
      /** True when the dropped response carried a server-managed `checkpoint`. */
      hadCheckpoint: boolean;
      /** A late JSON-RPC error, as `[code] message`, bounded. */
      error?: string;
    })

  // MCPL channels (mcpl/channel-registry.ts)
  /** A server's channels/register: the ids it registered. */
  | (TraceEventBase & {
      type: 'mcpl:channels-register';
      serverId: string;
      channelIds: string[];
      count: number;
    })
  /** A channel descriptor in a register or changed call was refused: one
   *  with no id, or an update for a channel not registered. */
  | (TraceEventBase & {
      type: 'mcpl:channel-descriptor-rejected';
      serverId: string;
      channelId?: string;
      reason: string;
    })
  /** A server's channels/changed: the ids it added, removed and updated. */
  | (TraceEventBase & {
      type: 'mcpl:channels-changed';
      serverId: string;
      added: string[];
      removed: string[];
      updated: string[];
    })
  /** A server's channels/incoming batch, once it has been answered. */
  | (TraceEventBase & {
      type: 'mcpl:channels-incoming';
      serverId: string;
      messageCount: number;
      channelIds: string[];
    })
  /** Traffic came for a channel no registration names, and the host
   *  registered it, under its label (or its id). */
  | (TraceEventBase & {
      type: 'mcpl:channel-lazy-registered';
      serverId: string;
      channelId: string;
      label: string;
    })
  /** Bringing a channel to the state the host decided for it (open, closed or
   *  tuned out) failed; `attempts` when it gave up because the channel's
   *  address, or the decision about it, kept changing. */
  | (TraceEventBase & {
      type: 'mcpl:channel-reconcile-failed';
      serverId: string;
      channelId: string;
      desired: 'open' | 'closed' | 'tuned-out' | undefined;
      attempts?: number;
      error: string;
    })
  /** A channels/open answered for another channel than the one asked for;
   *  `answeredFor` is the id (or value) it answered for, as logged. */
  | (TraceEventBase & {
      type: 'mcpl:channel-open-substituted';
      serverId: string;
      channelId: string;
      answeredFor: string;
    })
  /** Channel reconciliation was skipped for a server, such as one whose
   *  grant doesn't include channels.lifecycle. */
  | (TraceEventBase & {
      type: 'mcpl:channel-reconcile-skipped';
      serverId: string;
      reason: string;
    })
  /** A send opened a channel that wasn't open. */
  | (TraceEventBase & {
      type: 'mcpl:channel-opened-by-send';
      serverId: string;
      channelId: string;
    })
  /** A send's open of a channel failed. */
  | (TraceEventBase & {
      type: 'mcpl:channel-open-failed';
      serverId: string;
      channelId: string;
      error: string;
    })

  // MCPL state and checkpoints (mcpl/checkpoint-manager.ts)
  | (TraceEventBase & {
      type: 'mcpl:state_registered';
      serverId: string;
      featureSet: string;
      hostState: boolean;
      rollback: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:checkpoint_recorded';
      serverId: string;
      featureSet: string;
      checkpoint: string;
      parent: string | null;
      hasData: boolean;
      hasPatch: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:state_rollback';
      serverId: string;
      featureSet: string;
      checkpoint: string;
    })

  // Server-initiated inference (mcpl/inference-router.ts)
  | (TraceEventBase & {
      type: 'mcpl:inference_start';
      serverId: string;
      featureSet: string;
      model: string;
      stream: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:inference_complete';
      serverId: string;
      /** The routed model, as `mcpl:inference_start` has it. */
      model: string;
      /** The model the result reports, when membrane named one. */
      actualModel?: string;
      inputTokens: number;
      outputTokens: number;
      streamed: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:inference_fail';
      serverId: string;
      /** The routed model, or null for a request refused before any model
       *  was routed (no `mcpl:inference_start` precedes it). */
      model: string | null;
      error: string;
      streamed: boolean;
    })

  /** A push event admitted at the MCPL boundary (mcpl/push-handler.ts):
   *  `coalesce`, for an RFC-006 coalesced occurrence, is what the coalescer
   *  answered. */
  | (TraceEventBase & {
      type: 'mcpl:push_event';
      serverId: string;
      eventId: string;
      featureSet: string;
      coalesce?: PushEventResult['coalesce'];
    })

  // Ops / fleet observability. Everything the framework's opsAlert() escalates
  // (refusals, hard-down, MCPL unreachable, …) mirrored onto the trace bus so
  // authorized observers see alerts on the same wire as the rest of the
  // agent's internal life. Discord (CONNECTOME_OPS_WEBHOOK) is one sink of
  // this stream, not a separate system. See connectome docs/observability.md.
  | (TraceEventBase & {
      type: 'ops:alert';
      /** Alert kind — open set: 'refusal' | 'hard-down' | 'mcpl-down' | … */
      kind: string;
      /** Agent name, or a server/component id for non-agent alerts (e.g. mcpl-down). */
      agentName: string;
      /** At most 2,000 characters. */
      message: string;
      /** Kind-specific structured payload (mirrors the failures.log record),
       *  bounded field by field as that record is. */
      data?: Record<string, unknown>;
    })

  // Host quiesce/maintenance mode (issue #122)
  | (TraceEventBase & {
      type: 'host:quiesce';
      reason?: string;
      /** Whether all turns settled within the drain window. */
      drained: boolean;
      /** Turns still alive at return (0 unless the drain timed out). */
      activeTurns: number;
      /** Wakes still parked on provider admission at return (see HostModeStatus). */
      parkedAdmissions?: number;
      /** True when undrained turns were force-cancelled (abandon). */
      abandoned?: boolean;
      /** Agents whose turn the abandon had not ended when its grace ran out: a token held with no stream and no check ahead (a puppet tool turn, a store surgery's reservation, a turn finishing its last delivery), or a turn that hadn't reached its next check, the tool-result guard's wait for its speech included. A turn whose stream the abandon cancelled while it was still streaming isn't listed, even one still running when the grace ran out. */
      unabandonable?: string[];
    })
  | (TraceEventBase & {
      type: 'host:resume';
      /** True when a failing feasibility verdict was overridden. */
      forced?: boolean;
      /** Gated inference requests released back to the scheduler. */
      releasedRequests: number;
    })
  | (TraceEventBase & {
      type: 'host:quiesced_boot';
      reason?: string;
      since?: number;
    })

  // Tune-out (tune-out/coordinator.ts, issue #77)
  | (TraceEventBase & {
      type: 'tune-out:entered';
      serverId: string;
      channelId: string;
      epochId: string;
    })
  | (TraceEventBase & {
      type: 'tune-out:cancelled';
      serverId: string;
      channelId: string;
      epochId: string;
      reason: string;
      /** The mention-burst wakes the tune-out spent. */
      wakeCount: number;
    })
  /** A tune-out timer's work threw; reported rather than thrown into the
   *  event loop. */
  | (TraceEventBase & {
      type: 'tune-out:timer-failed';
      timer: 'cadence' | 'wake' | 'expiry';
      serverId: string;
      channelId: string;
      error: string;
    })
  /** Telling the server a message was suppressed by the tune-out
   *  (channels/acknowledge, intent `suppressed-tuned-out`) failed. */
  | (TraceEventBase & {
      type: 'tune-out:ack-failed';
      serverId: string;
      channelId: string;
      error: string;
    })

  // Inbound acceptance observation (mcpl/inbound-source.ts): an installed
  // InboundAcceptanceObserver threw. Delivery is unaffected; the observer's
  // own coverage is interrupted for that acceptance.
  | (TraceEventBase & {
      type: 'inbound:observer-failed';
      /** Envelope kind of the acceptance the observer failed on. */
      kind: 'channel' | 'unscoped' | 'surface';
      error: string;
    })

  // Held prose drafts (src/prose-drafts.ts): plain speech kept privately
  // instead of sent; a resident's explicit resend; a deliberate dismissal.
  | (TraceEventBase & TurnTraced & {
      type: 'prose:drafts-held';
      agentName: string;
      reason: DraftReason;
      draftIds: string[];
      textLen: number;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'prose:draft-resent';
      agentName: string;
      draftId: string;
      status: 'delivered' | 'failed' | 'unknown';
      serverId: string;
      channelId: string;
      messageId?: string;
    })
  | (TraceEventBase & TurnTraced & {
      type: 'prose:drafts-dismissed';
      agentName: string;
      draftIds: string[];
    });

/**
 * Listener for trace events.
 */
export type TraceEventListener = (event: TraceEvent) => void;

/**
 * A trace event as its emitter hands it to the framework, which stamps
 * `timestamp` on every event it delivers. The framework emits through a
 * method, and its components (the gate, the MCPL channel registry, push
 * handler, checkpoints, inference router and feature sets, the tune-out
 * coordinator) through hooks, that take this type, so an event the union
 * doesn't declare, a field written in the event that its entry doesn't
 * declare, or a turn's event without its turn, doesn't compile. A field a
 * spread brings in, or another value carries, isn't checked against the
 * entry.
 */
export type EmittedTraceEvent = TraceEvent extends infer E
  ? E extends TraceEventBase ? AgentNamed<TurnNamed<Unstamped<E>>> : never
  : never;

/** A `message:added` as its emitter gives it: it names the agent whose
 *  window holds the message, `agentName: undefined` where none does (a write
 *  whose target agent is gone), so a site that forgets to doesn't compile. */
type AgentNamed<E> = E extends { type: 'message:added' } ? E & { agentName: string | undefined } : E;

/** An event of a turn's (TurnTraced) as its emitter gives it: it names the
 *  turn, `turnId: undefined` where there is none, so a site that forgets to
 *  doesn't compile. An entry with an index signature (`mcpl:coalescing`)
 *  isn't a turn's. */
type TurnNamed<E> = string extends keyof E ? E : 'turnId' extends keyof E ? E & { turnId: number | undefined } : E;

/** `E` with `timestamp` optional. A key remapping rather than `Omit`, which
 *  would drop the declared fields of an entry with an index signature
 *  (`mcpl:coalescing`). */
type Unstamped<E> = { [K in keyof E as K extends 'timestamp' ? never : K]: E[K] } & { timestamp?: number };

/**
 * Every trace event type, as data: what a consumer such as a host's
 * telemetry builds its vocabulary from. It and the TraceEvent union are
 * checked against each other at compile time, both ways, so neither can grow
 * without the other.
 */
export const TRACE_EVENT_TYPES = [
  'process:received', 'process:completed', 'process:response-refused', 'inference:started',
  'inference:completed', 'inference:aborted', 'inference:failed', 'inference:exhausted',
  'inference:tokens', 'inference:content_block', 'inference:tool_calls_yielded',
  'inference:usage', 'inference:stream_resumed', 'inference:request', 'inference:stream_restarted',
  'inference:turn_ended', 'inference:published', 'inference:published_complete', 'tool:started',
  'tool:completed', 'tool:failed', 'tool:result_dropped', 'module:batch_hook_failed',
  'tool:spill_failed', 'module:added', 'module:removed', 'inference:request_dropped',
  'inference:request_stale', 'message:added', 'message:addressed', 'message:withdrawn', 'message:removed',
  'mcpl:push-event-rejected',
  'mcpl:channel-incoming-rejected', 'mcpl:malformed-content-refused',
  'mcpl:empty-content-dropped', 'mcpl:coalescing', 'gate:policy-matched', 'gate:config-error',
  'gate:debounce-delivered', 'gate:wake-line-omitted', 'gate:config-reloaded', 'gate:decision',
  'gate:policy-added', 'gate:policy-removed', 'gate:config-reconciled', 'gate:shadow-warnings',
  'usage:updated', 'undo:completed', 'redo:completed', 'operator:action', 'mcpl:server-stderr',
  'mcpl:conversation-spawned', 'mcpl:conversation-spawn-failed', 'mcpl:conversation-unrouted',
  'mcpl:conversation-binding-orphaned', 'mcpl:conversation-closed', 'mcpl:conversation-disposed',
  'mcpl:speech-routed', 'mcpl:speech-route-failed', 'puppet:tool-call',
  'mcpl:server-connect-failed', 'mcpl:manifest-change-receipt', 'mcpl:server-reconnected',
  'mcpl:server-closed', 'mcpl:server-error', 'mcpl:policy-refused', 'mcpl:feature-set-disabled',
  'mcpl:tool-pattern-unmatched', 'mcpl:request-handler-error', 'mcpl:orphaned-response',
  'mcpl:channels-register', 'mcpl:channel-descriptor-rejected', 'mcpl:channels-changed',
  'mcpl:channels-incoming', 'mcpl:channel-lazy-registered', 'mcpl:channel-reconcile-failed',
  'mcpl:channel-open-substituted', 'mcpl:channel-reconcile-skipped',
  'mcpl:channel-opened-by-send', 'mcpl:channel-open-failed', 'mcpl:state_registered',
  'mcpl:checkpoint_recorded', 'mcpl:state_rollback', 'mcpl:inference_start',
  'mcpl:inference_complete', 'mcpl:inference_fail', 'mcpl:push_event', 'ops:alert',
  'host:quiesce', 'host:resume', 'host:quiesced_boot', 'tune-out:entered', 'tune-out:cancelled',
  'tune-out:timer-failed', 'tune-out:ack-failed', 'inbound:observer-failed', 'prose:drafts-held',
  'prose:draft-resent', 'prose:drafts-dismissed',
] as const satisfies readonly TraceEvent['type'][];

/** A type the union has and the list doesn't, if any: `never` while they agree. */
type UnlistedTraceEventType = Exclude<TraceEvent['type'], (typeof TRACE_EVENT_TYPES)[number]>;
/** Fails to compile, naming the type, when the union gains one the list lacks
 *  (the list's `satisfies` catches the other direction). */
const everyTraceEventTypeListed: [UnlistedTraceEventType] extends [never] ? true : UnlistedTraceEventType = true;
void everyTraceEventTypeListed;

/**
 * The `ops:alert` kinds agent-framework raises itself, its bundled
 * workspace module's included, as data. The framework's own alerts take
 * their kind from this list (OpsAlertKind), so a new one can't be raised
 * unlisted, and the workspace module's kind is checked against it.
 * `ops:alert`'s `kind` stays an open string: a host's alerts (`notifyOps`,
 * `notifyOpsAlert`) and another module's (`ModuleContext.notifyOps`) name
 * kinds of their own.
 */
export const OPS_ALERT_KINDS = [
  'context-maintenance-failed', 'context-refusal', 'deferred-writes', 'discord-awareness-delivery',
  'discord-awareness-import-unsent', 'discord-awareness-not-scheduled', 'discord-awareness-unresolved',
  'hard-down', 'mcpl-down', 'mcpl-tool-duplicate', 'provider-wait', 'recovery-sync', 'refusal',
  'thinking-binding-loss', 'workspace-mount-not-direct',
] as const;

/** An `ops:alert` kind agent-framework raises (OPS_ALERT_KINDS). */
export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number];
