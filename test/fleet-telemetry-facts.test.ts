/**
 * The facts agent-framework gives a host's fleet telemetry, on its trace:
 * the trace and ops-alert vocabularies as data; the logical turn each of a
 * turn's events belongs to; each addressed message's storage, its first
 * delivery into its agent's provider input, or its withdrawal; the holds a
 * message waits under; and each request a turn sends, with the id it gives
 * membrane as the call's option and its inference-log entry names.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework, OPS_ALERT_KINDS, TRACE_EVENT_TYPES } from '../src/index.js';
import { AddressedMessages } from '../src/addressed-messages.js';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig } from '../src/gate/types.js';
import { removeStoredMessage } from '../src/stored-removal.js';
import { heldHandle } from '../src/held-writes.js';
import { carriedBodies } from '../src/agent.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import { AutobiographicalStrategy, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContextManager, MessageId } from '@animalabs/context-manager';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { forceExpiry } from './helpers/force-expiry.js';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

type Placement = { agent?: string; messageId?: string; deferredId?: string };
type Internals = {
  deferredMessages: Array<{ id: string }>;
  unackedDeferredWrites: Array<{ id: string }>;
  eventGate: EventGate | null;
  subconsciousAgentName: string | undefined;
  tuneOutCoordinator: unknown;
  agents: Map<string, { getContextManager(): { addMessage(p: string, c: ContentBlock[]): string } }>;
  noteAddressed(agentName: string, placement: Placement, held?: 'sleep'): void;
  removePlacement(p: Placement & { agent: string }): boolean;
  dispatchToolCall(agentName: string, call: ToolCall, turnId?: number): void;
  dispatchSleepToolCall(agentName: string, call: ToolCall): void;
  scriptWake(agentName: string, scriptId: string, text: string, label: string): Promise<void>;
  bounceProse(agent: unknown, text: string, reason: string, candidates: undefined, prefix: '>>', round: unknown): void;
  turnRouting: Map<string, unknown>;
  pendingRequests: Array<Record<string, unknown>>;
  endContinuedTurn(agentName: string, drop: { kind: 'dropped'; why: string }): void;
  traceToolOutcome(module: string, agentName: string, call: ToolCall, result: ToolResult, durationMs: number): void;
  handleMcplChannelIncoming(event: unknown): Promise<unknown>;
  disposeConversationAgent(agentName: string): void;
  deliverAddressed(agent: unknown, carried: () => Iterable<string>, compiled: boolean, dropped?: () => Iterable<string>, summaries?: () => Iterable<string>): Array<{ messageId: string; form: string }>;
  summaryCovers(cm: unknown, id: string): ReadonlySet<string>;
  addressedMessages: AddressedMessages;
  removeMessage(id: string): void;
  deliverCoalesced(occ: unknown, materialized?: unknown[], assemblingFor?: string): Promise<unknown>;
  queueCoalescedWakes(occ: unknown, plain?: boolean, readsDeferredWrite?: string, allAmbient?: boolean): Promise<void>;
  draftsToolResult(agentName: string, input: unknown, turn: undefined, callId: string, callTurnId?: number): Promise<ToolResult>;
  proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: string): { held: Array<{ id: string }> } };
  lastConversationSweep: number;
  sweepExpiredConversations(): void;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

async function until(done: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  for (const end = Date.now() + timeoutMs; !done();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A tool round held open while `during` writes something, until that write
 *  is deferred behind the busy agent, and then `deferred` runs. Module events
 *  with text make messages and ask for inference. */
class HoldModule implements Module {
  readonly name = 'hold';
  framework: AgentFramework | null = null;
  during: (() => unknown) | null = null;
  deferred: (() => void | Promise<void>) | null = null;
  /** The inference its responses request, and how many messages each adds. */
  wake: true | string[] = true;
  adds = 1;
  /** Run as a tool batch completes, before the turn goes on. */
  batchHook: (() => Promise<void>) | null = null;

  async onToolBatchComplete(): Promise<void> {
    await this.batchHook?.();
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      { name: 'wait', description: 'Wait for something', inputSchema: { type: 'object', properties: {} } },
      { name: 'stop', description: 'End the turn', inputSchema: { type: 'object', properties: {} } },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    if (during) {
      const fw = internals(this.framework!);
      const queued = fw.deferredMessages.length;
      await during();
      await until(() => fw.deferredMessages.length > queued, 'the mid-turn write to be deferred');
      await this.deferred?.();
      this.deferred = null;
    }
    if (call.name.endsWith('stop')) return { success: true, data: { stopped: true }, endTurn: true };
    return { success: true, data: { ok: true } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content } = event as unknown as { content: string };
    const addMessages = Array.from({ length: this.adds }, (_, i) => ({ participant: 'Antra', content: [{ type: 'text' as const, text: i === 0 ? content : `${content} (${i + 1})` }] }));
    return { addMessages, requestInference: this.wake };
  }
}

/** Each turn its own responses; `injects` is what each stream declares about
 *  carrying injected messages. Records each call's options. */
function scheduleTurns(membrane: MockMembrane, turns: NormalizedResponse[][], injects: 'declared' | 'undeclared' | 'declared false' = 'declared') {
  const streams: MockYieldingStream[] = [];
  const options: unknown[] = [];
  (membrane as unknown as { streamYielding: (req: NormalizedRequest, opts?: unknown) => MockYieldingStream }).streamYielding = (req, opts) => {
    membrane.calls.push(req);
    options.push(opts);
    const stream = new MockYieldingStream(turns[streams.length] ?? [createMockResponse([text('fallback')])], injects === 'declared' ? true : injects === 'declared false' ? false : undefined);
    streams.push(stream);
    membrane.lastStream = stream;
    return stream;
  };
  return { streams, options };
}

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const toolCall = (id: string, name: string): ToolCall => ({ id, name, input: {} }) as ToolCall;
const go = (content = 'go') => ({ type: 'external-message', source: 'test', content }) as unknown as ProcessEvent;
const channelMessage = (messageId: string, body: string, extra: Record<string, unknown> = {}) => ({
  type: 'mcpl:channel-incoming',
  serverId: 'chat',
  channelId: 'chat:room',
  messageId,
  author: { id: 'u-1', name: 'someone' },
  content: [text(body)],
  timestamp: new Date().toISOString(),
  tags: ['chat:addressed'],
  triggerInference: true,
  ...extra,
}) as unknown as ProcessEvent;
const pushMessage = (eventId: string, body: string, extra: Record<string, unknown> = {}) => ({
  type: 'mcpl:push-event',
  serverId: 'feed',
  featureSet: 'feed.items',
  eventId,
  inferenceId: `inf-${eventId}`,
  content: [text(body)],
  timestamp: new Date().toISOString(),
  triggerInference: true,
  ...extra,
}) as unknown as ProcessEvent;

/** A request's first deliveries, each `whole`. */
const whole = (...ids: string[]) => ids.map((messageId) => ({ messageId, form: 'whole' }));
type Delivery = { messageId: string; form: string };

/** The types whose union entry names a turn (TurnTraced): an entry with a
 *  `turnId` key, an open record's index signature aside. */
type TurnTracedType = TraceEvent extends infer E
  ? E extends { type: infer T } ? (string extends keyof E ? never : 'turnId' extends keyof E ? T : never) : never
  : never;
/** Those types as data, checked against the union both ways. */
const TURN_TRACED_TYPES = [
  'inference:started', 'inference:completed', 'inference:aborted', 'inference:failed', 'inference:exhausted',
  'inference:tokens', 'inference:content_block', 'inference:tool_calls_yielded', 'inference:usage',
  'inference:stream_resumed', 'inference:request', 'inference:stream_restarted', 'inference:turn_ended',
  'inference:published', 'inference:published_complete', 'tool:started', 'tool:completed', 'tool:failed',
  'module:batch_hook_failed', 'prose:drafts-held', 'prose:draft-resent', 'prose:drafts-dismissed',
] as const satisfies readonly TurnTracedType[];
const everyTurnTracedTypeListed: [Exclude<TurnTracedType, (typeof TURN_TRACED_TYPES)[number]>] extends [never] ? true : false = true;
void everyTurnTracedTypeListed;

/** The trace events of `type`, as `T`. */
function ofType<T = Record<string, unknown>>(traces: TraceEvent[], type: string): T[] {
  return traces.filter((e) => e.type === type) as unknown as T[];
}

describe('fleet telemetry facts', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: HoldModule;
  let traces: TraceEvent[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'telemetry-facts-'));
    membrane = new MockMembrane();
    module = new HoldModule();
    traces = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(opts: { gate?: GateConfig } = {}): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' }],
      modules: [module],
      ...(opts.gate ? { gate: { config: opts.gate } } : {}),
    });
    module.framework = framework;
    framework.onTrace((event) => traces.push(event));
    return framework;
  }

  // ---------------------------------------------------------------------------
  // Vocabularies

  it('TRACE_EVENT_TYPES lists each trace type once, the ones components emit among them', () => {
    assert.equal(new Set(TRACE_EVENT_TYPES).size, TRACE_EVENT_TYPES.length);
    for (const type of ['tune-out:entered', 'gate:policy-added', 'mcpl:channels-register', 'mcpl:push_event', 'inference:request', 'message:addressed']) {
      assert.ok((TRACE_EVENT_TYPES as readonly string[]).includes(type), type);
    }
  });

  it("OPS_ALERT_KINDS lists each of the framework's own alert kinds once", () => {
    assert.equal(new Set(OPS_ALERT_KINDS).size, OPS_ALERT_KINDS.length);
    for (const kind of ['refusal', 'hard-down', 'mcpl-down', 'provider-wait', 'workspace-mount-not-direct']) {
      assert.ok((OPS_ALERT_KINDS as readonly string[]).includes(kind), kind);
    }
  });

  // ---------------------------------------------------------------------------
  // The logical turn

  it("every event of a turn names the turn, and its tool events their agent; the next turn's id is larger", async () => {
    scheduleTurns(membrane, [
      [createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])],
      [createMockResponse([text('again')])],
    ]);
    const framework = await createFramework();
    framework.pushEvent(go());
    await framework.runUntilIdle();
    framework.pushEvent(go('once more'));
    await framework.runUntilIdle();

    const started = ofType<{ turnId?: number }>(traces, 'inference:started');
    assert.equal(started.length, 2);
    const [first, second] = started.map((e) => e.turnId);
    assert.equal(typeof first, 'number');
    assert.ok(second! > first!, `the next turn's id is larger: ${first}, ${second}`);
    const firstTurn = traces.slice(0, traces.findIndex((e) => e === (started[1] as unknown)));
    // Every event of a type that names a turn (TurnTraced), so one without
    // its turnId fails.
    const ofTurn = firstTurn.filter((e) => (TURN_TRACED_TYPES as readonly string[]).includes(e.type));
    for (const type of ['inference:started', 'inference:request', 'inference:content_block', 'inference:stream_resumed', 'inference:completed', 'tool:started', 'tool:completed']) {
      assert.ok(ofTurn.some((e) => e.type === type), `the turn emitted ${type}`);
    }
    for (const event of ofTurn) assert.equal((event as { turnId?: number }).turnId, first, `${event.type} names the turn`);
    const requestIds = ofType<{ requestId: string }>(traces, 'inference:request').map((e) => e.requestId);
    assert.equal(requestIds.length, 2);
    assert.notEqual(requestIds[0], requestIds[1], "each request has its own id");
    const toolStarted = ofType<{ agentName?: string }>(firstTurn, 'tool:started')[0]!;
    assert.equal(toolStarted.agentName, 'assistant');
    await framework.stop();
  });

  it("a tool call's events name the turn it was made in, not the agent's latest", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hello')])]]);
    const framework = await createFramework();
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const latest = ofType<{ turnId: number }>(traces, 'inference:started')[0]!.turnId;

    // A call made in turn 1000, such as a script's that outlived its turn.
    internals(framework).dispatchToolCall('assistant', toolCall('late-1', 'hold--wait'), 1000);
    await framework.runUntilIdle();
    await until(() => traces.some((e) => e.type === 'tool:completed'), 'the late call to finish');
    const started = ofType<{ turnId?: number; agentName?: string; callId: string }>(traces, 'tool:started').find((e) => e.callId === 'late-1')!;
    const completed = ofType<{ turnId?: number; callId: string }>(traces, 'tool:completed').find((e) => e.callId === 'late-1')!;
    assert.notEqual(latest, 1000);
    assert.deepEqual([started.turnId, started.agentName, completed.turnId], [1000, 'assistant', 1000]);
    await framework.stop();
  });

  for (const [ends, tool, last] of [
    ['resumes', 'hold--wait', 'inference:stream_resumed'],
    ['ends the turn', 'hold--stop', 'inference:turn_ended'],
  ] as const) {
    it(`a tool round that ${ends} names its turn, though the agent's routing changes while its results are stored`, async () => {
      scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', tool)], 'tool_use'), createMockResponse([text('done')])]]);
      const framework = await createFramework();
      const fw = internals(framework) as Internals & { buildStoredToolResultContent(...args: unknown[]): Promise<unknown> };
      // While the round's results are stored, the agent's routing is
      // replaced, as by a newer turn; it's put back at the round's event.
      const build = fw.buildStoredToolResultContent;
      let original: unknown;
      fw.buildStoredToolResultContent = async (...args: unknown[]) => {
        const built = await build.apply(fw, args);
        original = fw.turnRouting.get('assistant');
        fw.turnRouting.set('assistant', { ...(original as object), turnId: 999 });
        return built;
      };
      framework.onTrace((event) => {
        if (event.type === last && original !== undefined) fw.turnRouting.set('assistant', original);
      });
      framework.pushEvent(go());
      await framework.runUntilIdle();
      const turn = ofType<{ turnId?: number }>(traces, 'inference:started')[0]!.turnId;
      assert.equal(typeof turn, 'number', 'premise: the turn has an id');
      assert.ok(original !== undefined, 'premise: the routing was replaced');
      assert.deepEqual(ofType<{ turnId?: number }>(traces, last).map((e) => e.turnId), [turn]);
      await framework.stop();
    });
  }

  it("a failed tool result with no error text is traced as failed, saying so", async () => {
    const framework = await createFramework();
    internals(framework).traceToolOutcome('gate', 'assistant', { ...toolCall('t-1', 'gate_status'), callerTurnId: 7 } as ToolCall, { success: false, isError: true }, 3);
    const failed = ofType(traces, 'tool:failed')[0]!;
    assert.deepEqual(
      { error: failed.error, turnId: failed.turnId, agentName: failed.agentName, durationMs: failed.durationMs },
      { error: 'tool returned an error', turnId: 7, agentName: 'assistant', durationMs: 3 },
    );
    internals(framework).traceToolOutcome('gate', 'assistant', toolCall('t-2', 'gate_status'), { success: false, isError: true, error: '' }, 0);
    assert.equal(ofType(traces, 'tool:failed').find((e) => e.callId === 't-2')!.error, 'tool returned an error', 'an empty text too');
    await framework.stop();
  });

  it("a failed result from the framework's own tools is traced as failed, with its text", async () => {
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    const fw = internals(framework);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['wake_add_rule', {}],
      ['fetch_reference', {}],
      ['read_image', { path: 'nowhere.png' }],
      ['save_recent_image', {}],
      ['agent_settings', { action: 'bogus' }],
    ];
    for (const [i, [name, input]] of calls.entries()) fw.dispatchToolCall('assistant', { id: `own-${i}`, name, input } as ToolCall, 5);
    await until(() => calls.every((_, i) => traces.some((e) => e.type.startsWith('tool:') && e.type !== 'tool:started' && (e as { callId?: string }).callId === `own-${i}`)), 'every call to finish');
    for (const [i, [name]] of calls.entries()) {
      const ended = traces.filter((e) => (e.type === 'tool:failed' || e.type === 'tool:completed') && (e as { callId?: string }).callId === `own-${i}`);
      assert.deepEqual(ended.map((e) => e.type), ['tool:failed'], name);
      const failed = ended[0] as { error: string; turnId?: number; agentName?: string };
      assert.ok(failed.error.length > 0, `${name} says why`);
      assert.notEqual(failed.error, 'tool returned an error', `${name} keeps its own text, not the fallback's`);
      assert.deepEqual([failed.turnId, failed.agentName], [5, 'assistant'], name);
    }
    await framework.stop();
  });

  it("a programmatic call its agent may not make is traced as failed, naming the agent", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'allowed.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled', allowedTools: ['hold--wait'] }],
      modules: [module],
    });
    framework.onTrace((event) => traces.push(event));
    const result = await framework.executeToolCall({ ...toolCall('denied-1', 'hold--stop'), callerAgentName: 'assistant' } as ToolCall);
    assert.equal(result.isError, true, 'premise: the call is refused');
    const failed = ofType(traces, 'tool:failed').find((e) => e.callId === 'denied-1')!;
    assert.equal(failed.agentName, 'assistant');
    await framework.stop();
  });

  it("a call the agent's allowed tools refuse is traced as failed in the turn that made it", async () => {
    scheduleTurns(membrane, [[createMockResponse([call('c-no', 'hold--stop')], 'tool_use'), createMockResponse([text('fine')])]]);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'refused.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled', allowedTools: ['hold--wait'] }],
      modules: [module],
    });
    framework.onTrace((event) => traces.push(event));
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const failed = ofType(traces, 'tool:failed').find((e) => e.callId === 'c-no')!;
    assert.match(String(failed.error), /not permitted/, 'premise: refused by allowedTools');
    const turn = ofType<{ turnId?: number }>(traces, 'inference:started')[0]!.turnId;
    assert.equal(typeof turn, 'number', 'premise: the turn has an id');
    assert.equal(failed.turnId, turn);
    await framework.stop();
  });

  it("the drafts tool's events name the turn its call was made in: a dismissal, a failed one and a resend, dispatched or called as its agent", async () => {
    const framework = await createFramework();
    const fw = internals(framework) as Internals & {
      channelRegistry: unknown;
      draftStateNow(agentName: string, id: string): string;
    };
    const hold = (words: string) => fw.proseDrafts.hold('assistant', [{ text: words }], 'no-destination').held[0]!.id;
    const room = { serverId: 'chat', channelId: 'room' };
    // Only what each action here reads of the registry.
    const registry = fw.channelRegistry;
    fw.channelRegistry = {
      resolveProseTarget: () => room,
      resolveDestination: () => ({ destination: room }),
      publish: async () => ({ status: 'sent', destination: room, messageId: 'posted-1' }),
    };
    const dispatched = async (id: string, input: Record<string, unknown>, turnId: number, type: string) => {
      fw.dispatchToolCall('assistant', { id, name: 'drafts', input } as ToolCall, turnId);
      await until(() => traces.some((e) => e.type === type && (e as { turnId?: number }).turnId === turnId), `${type} in turn ${turnId}`);
    };
    try {
      const dismissedId = hold('words never sent');
      await dispatched('d-1', { action: 'dismiss', draftIds: [dismissedId] }, 42, 'prose:drafts-dismissed');
      // A dismissal whose record throws after reaching the journal.
      const failedId = hold('a dismissal that throws');
      const dismiss = (fw.proseDrafts as unknown as { dismiss: (...args: unknown[]) => unknown }).dismiss;
      (fw.proseDrafts as unknown as { dismiss: () => never }).dismiss = () => { throw new Error('the journal write failed'); };
      const stateNow = fw.draftStateNow;
      fw.draftStateNow = () => 'dismissed';
      try {
        await dispatched('d-2', { action: 'dismiss', draftIds: [failedId] }, 43, 'prose:drafts-dismissed');
      } finally {
        (fw.proseDrafts as unknown as { dismiss: unknown }).dismiss = dismiss;
        fw.draftStateNow = stateNow;
      }
      const resentId = hold('words to send again');
      await dispatched('d-3', { action: 'resend', draftIds: [resentId], destination: '#room' }, 44, 'prose:draft-resent');
      // Called as its agent (a puppet's call), with the turn the call carries.
      const puppetedId = hold('a puppet dismisses this');
      await framework.executeToolCall({ id: 'd-4', name: 'drafts', input: { action: 'dismiss', draftIds: [puppetedId] }, callerAgentName: 'assistant', callerTurnId: 45 } as ToolCall);
      assert.deepEqual(ofType(traces, 'prose:drafts-dismissed').map((e) => [e.draftIds, e.turnId]),
        [[[dismissedId], 42], [[failedId], 43], [[puppetedId], 45]]);
      assert.deepEqual(ofType(traces, 'prose:draft-resent').map((e) => [e.draftId, e.status, e.turnId]), [[resentId, 'sent', 44]]);
    } finally {
      fw.channelRegistry = registry;
    }
    await framework.stop();
  });

  // ---------------------------------------------------------------------------
  // A turn's requests

  it("inference:request names the requestId the call gives membrane, which the inference log's entry has too, and a turn's completion its stop reason", async () => {
    const { options } = scheduleTurns(membrane, [[createMockResponse([text('hello')])]]);
    const framework = await createFramework();
    framework.pushEvent(go());
    await framework.runUntilIdle();

    const request = ofType<{ requestId: string; turnId?: number }>(traces, 'inference:request');
    assert.equal(request.length, 1);
    assert.equal((options[0] as { requestId?: string }).requestId, request[0]!.requestId);
    const logged = framework.queryInferenceLogs({ agentName: 'assistant' }).entries.map((e) => e.entry.requestId);
    assert.deepEqual(logged, [request[0]!.requestId]);
    assert.equal(request[0]!.turnId, ofType<{ turnId: number }>(traces, 'inference:started')[0]!.turnId);
    assert.equal(ofType(traces, 'inference:completed')[0]!.stopReason, 'end_turn');
    await framework.stop();
  });

  it("a turn's completion names the stop reason its final response gave", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('cut off')], 'max_tokens')]]);
    const framework = await createFramework();
    framework.pushEvent(go());
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'inference:completed').map((e) => e.stopReason), ['max_tokens']);
    await framework.stop();
  });

  it('a turn a tool ended completes with no stop reason', async () => {
    scheduleTurns(membrane, [[createMockResponse([call('c9', 'hold--stop')], 'tool_use')]]);
    const framework = await createFramework();
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const completed = ofType(traces, 'inference:completed');
    assert.equal(completed.length, 1);
    assert.equal('stopReason' in completed[0]!, false);
    await framework.stop();
  });

  // ---------------------------------------------------------------------------
  // Addressed messages

  it('a message woken for at once is addressed to the agent whose window holds it, and delivered by the request its turn sends', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    const framework = await createFramework();
    framework.pushEvent(channelMessage('m-1', 'hello there'));
    await framework.runUntilIdle();

    const added = ofType<{ messageId: string; agentName?: string; source: string }>(traces, 'message:added')
      .find((e) => e.source === 'mcpl:channel-incoming')!;
    assert.equal(added.agentName, 'assistant');
    assert.ok(added.messageId, 'stored at once');
    const addressed = ofType(traces, 'message:addressed');
    assert.deepEqual(addressed.map((e) => [e.messageId, e.agentName, e.held, e.untracked]), [[added.messageId, 'assistant', undefined, undefined]]);
    const request = ofType<{ delivered?: Delivery[] }>(traces, 'inference:request');
    assert.deepEqual(request.map((e) => e.delivered), [whole(added.messageId)]);
    await framework.stop();
  });

  it('a message stored with no wake asked, now or held, is not addressed', async () => {
    const framework = await createFramework();
    framework.pushEvent(channelMessage('m-1', 'chatter', { triggerInference: false, tags: ['chat:ambient'] }));
    await framework.runUntilIdle();
    assert.ok(ofType(traces, 'message:added').length > 0);
    assert.equal(ofType(traces, 'message:addressed').length, 0);
    await framework.stop();
  });

  for (const [later, held] of [['sleep', 'sleep'], ['debounce', undefined]] as const) {
    it(`a message whose wake comes later (${later}) is addressed${held ? ', held by the sleep' : ''}`, async () => {
      const framework = await createFramework();
      framework.pushEvent(channelMessage('m-1', 'later', { triggerInference: false, wakeLater: later }));
      await framework.runUntilIdle();
      const addressed = ofType(traces, 'message:addressed');
      assert.deepEqual(addressed.map((e) => [e.agentName, e.held]), [['assistant', held]]);
      assert.equal(membrane.calls.length, 0, 'no turn yet');
      await framework.stop();
    });
  }

  it('a push woken for at once, or later, is addressed to the agent whose window holds it; one with no wake is not', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('seen')])]]);
    const framework = await createFramework();
    framework.pushEvent(pushMessage('p-1', 'a new item'));
    await framework.runUntilIdle();
    framework.pushEvent(pushMessage('p-2', 'after the sleep', { triggerInference: false, wakeLater: 'sleep' }));
    framework.pushEvent(pushMessage('p-3', 'just so you know', { triggerInference: false }));
    await framework.runUntilIdle();

    const added = ofType<{ messageId: string; agentName?: string; source: string }>(traces, 'message:added')
      .filter((e) => e.source === 'mcpl:push-event');
    assert.equal(added.length, 3);
    assert.ok(added.every((e) => e.agentName === 'assistant' && e.messageId));
    assert.deepEqual(
      ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName, e.held]),
      [[added[0]!.messageId, 'assistant', undefined], [added[1]!.messageId, 'assistant', 'sleep']],
    );
    assert.deepEqual(ofType<{ delivered?: Delivery[] }>(traces, 'inference:request').map((e) => e.delivered), [whole(added[0]!.messageId)]);
    await framework.stop();
  });

  for (const lane of ['channel', 'push'] as const) {
    it(`a ${lane} message woken for in agents whose windows don't hold it is not addressed`, async () => {
      const framework = await createFramework();
      const only = { targetAgents: ['someone-else'] };
      framework.pushEvent(lane === 'channel' ? channelMessage('m-1', 'for another', only) : pushMessage('p-1', 'for another', only));
      await framework.runUntilIdle();
      assert.ok(ofType<{ agentName?: string }>(traces, 'message:added').some((e) => e.agentName === 'assistant'), 'stored in the window');
      assert.equal(ofType(traces, 'message:addressed').length, 0);
      await framework.stop();
    });
  }

  for (const lane of ['channel', 'push'] as const) {
    it(`a ${lane} message is addressed to each agent woken that reads the residents' slot, and a batch's to every one`, async () => {
      scheduleTurns(membrane, []);
      const framework = await AgentFramework.create({
        storePath: join(tempDir, `slot-${lane}.chronicle`),
        membrane: membrane.asMembrane(),
        agents: [
          { name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' },
          { name: 'helper', model: 'test-model', systemPrompt: 'You help.', proseRouting: 'disabled' },
        ],
        modules: [],
      });
      framework.onTrace((event) => traces.push(event));
      const message = (id: string, extra: Record<string, unknown>) => lane === 'channel' ? channelMessage(id, id, extra) : pushMessage(id, id, extra);
      const addressedTo = (id: string) => ofType<{ messageId: string; agentName: string; held?: string }>(traces, 'message:addressed')
        .filter((e) => e.messageId === id).map((e) => [e.agentName, e.held]);
      const stored = () => ofType<{ messageId: string }>(traces, 'message:added').at(-1)!.messageId;
      framework.pushEvent(message('m-later', { triggerInference: false, wakeLater: 'debounce', targetAgents: ['assistant'] }));
      await framework.runUntilIdle();
      assert.deepEqual(addressedTo(stored()), [['assistant', undefined], ['helper', undefined]], "a batch's end wakes every agent but the subconscious");
      framework.pushEvent(message('m-held', { triggerInference: false, wakeLater: 'sleep', targetAgents: ['assistant'] }));
      await framework.runUntilIdle();
      assert.deepEqual(addressedTo(stored()), [['assistant', 'sleep']], 'the sleep holds the wake the event asked');
      framework.pushEvent(message('m-now', {}));
      await framework.runUntilIdle();
      assert.deepEqual(addressedTo(stored()), [['assistant', undefined], ['helper', undefined]]);
      await framework.stop();
    });
  }

  it('a message heard at a tool boundary is named by its deferred id, and delivered there', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const framework = await createFramework();
    module.during = () => framework.pushEvent(channelMessage('m-mid', 'also this'));
    framework.pushEvent(go());
    await framework.runUntilIdle();

    const added = ofType<{ messageId: string; deferredId?: string; source: string }>(traces, 'message:added')
      .find((e) => e.source === 'mcpl:channel-incoming')!;
    assert.equal(added.messageId, '', 'deferred at arrival');
    assert.ok(added.deferredId);
    assert.ok(ofType(traces, 'message:addressed').some((e) => e.messageId === added.deferredId));
    const resumed = ofType<{ delivered?: Delivery[] }>(traces, 'inference:stream_resumed');
    assert.deepEqual(resumed.map((e) => e.delivered), [whole(added.deferredId!)]);
    await framework.stop();
  });

  for (const injects of ['undeclared', 'declared false'] as const) it(`where the stream doesn't say it carries injected messages (${injects}), the boundary delivers nothing and the next compile does`, async () => {
    scheduleTurns(membrane, [
      [createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])],
      [createMockResponse([text('now then')])],
    ], injects);
    const framework = await createFramework();
    module.during = () => framework.pushEvent(channelMessage('m-mid', 'also this'));
    framework.pushEvent(go());
    await framework.runUntilIdle();

    const deferredId = ofType<{ deferredId?: string; source: string }>(traces, 'message:added')
      .find((e) => e.source === 'mcpl:channel-incoming')!.deferredId!;
    const resumed = ofType<{ delivered?: Delivery[] }>(traces, 'inference:stream_resumed');
    assert.ok(resumed.length > 0, 'the boundary was reached');
    assert.ok(resumed.every((e) => e.delivered === undefined));
    const requests = ofType<{ delivered?: Delivery[] }>(traces, 'inference:request');
    assert.equal(requests.length, 2, "the message's wake started a turn");
    assert.ok(!requests[0]!.delivered?.some((d) => d.messageId === deferredId), 'the first turn\'s own request predates it');
    assert.deepEqual(requests[1]!.delivered, whole(deferredId));
    await framework.stop();
  });

  it('a module event with a wake is addressed, held where the sleep holds it; one the gate defers is not, asleep or awake', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    framework.pushEvent(go('wake me'));
    await framework.runUntilIdle();
    internals(framework).eventGate!.setSleep(3600, undefined, 'assistant');
    framework.pushEvent(go('while asleep'));
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.agentName, e.held]), [['assistant', undefined], ['assistant', 'sleep']]);
    await framework.stop();

    traces.length = 0;
    const deferring = await createFramework({ gate: { policies: [], default: 'defer' } });
    deferring.pushEvent(go('not now'));
    await deferring.runUntilIdle();
    internals(deferring).eventGate!.setSleep(3600, undefined, 'assistant');
    deferring.pushEvent(go('while asleep'));
    await deferring.runUntilIdle();
    assert.equal(ofType(traces, 'message:added').filter((e) => e.source === 'external-message').length, 2, 'premise: both stored');
    assert.equal(ofType(traces, 'message:addressed').length, 0, 'a defer by policy addresses nothing, and the sleep holds no wake for it');
    await deferring.stop();
  });

  it("a module's message the gate batches is addressed to every agent the batch wakes; one the sleep holds, to those the request would wake now", async () => {
    scheduleTurns(membrane, []);
    const create = (name: string, gate: GateConfig) => AgentFramework.create({
      storePath: join(tempDir, `${name}.chronicle`),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' },
        // Not woken by a module's events: a source it doesn't take.
        { name: 'helper', model: 'test-model', systemPrompt: 'You help.', proseRouting: 'disabled', triggerSources: ['elsewhere'] },
      ],
      modules: [module],
      gate: { config: gate },
    });
    module.wake = ['assistant'];
    const batching = await create('batching', { policies: [{ name: 'batch', match: {}, behavior: { debounce: 600_000 } }], default: 'always' });
    module.framework = batching;
    batching.onTrace((event) => traces.push(event));
    batching.pushEvent(go('in the batch'));
    await batching.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.agentName, e.held]), [['assistant', undefined], ['helper', undefined]]);
    await batching.stop();

    traces.length = 0;
    module.wake = true;
    const sleeping = await create('sleeping', { policies: [], default: 'always' });
    module.framework = sleeping;
    sleeping.onTrace((event) => traces.push(event));
    internals(sleeping).eventGate!.setSleep(3600);
    sleeping.pushEvent(go('while asleep'));
    await sleeping.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.agentName, e.held]), [['assistant', 'sleep']], "not the agent the source can't wake");
    await sleeping.stop();
  });

  it('each message a response adds with a wake is addressed', async () => {
    scheduleTurns(membrane, []);
    module.adds = 2;
    const framework = await createFramework();
    framework.pushEvent(go('two at once'));
    await framework.runUntilIdle();
    const added = ofType<{ messageId: string; source: string }>(traces, 'message:added').filter((e) => e.source === 'external-message').map((e) => e.messageId);
    assert.equal(added.length, 2);
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.messageId), added);
    await framework.stop();
  });

  it('a message a response adds is addressed to an agent once while recorded, however often its wake is asked', async () => {
    scheduleTurns(membrane, []);
    module.wake = ['assistant', 'assistant'];
    const framework = await createFramework();
    framework.pushEvent(go('twice over'));
    await framework.runUntilIdle();
    assert.equal(ofType(traces, 'message:addressed').length, 1);
    await framework.stop();
  });

  it("an addressed message a request carries only inside a summary ends its wait there, delivered in the summary's form", async () => {
    scheduleTurns(membrane, []);
    // The compression's calls are answered with a summary of their own.
    membrane.complete = async () => createMockResponse([text('SUMMARY of the earlier talk')]);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'summarized.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled',
        strategy: new AutobiographicalStrategy({
          compressionModel: 'test-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
          autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
        }),
      }],
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    const fw = internals(framework);
    const filler = ' substantive'.repeat(18);
    // Addressed while the agent sleeps, then pushed out of the recent window
    // by the channel's traffic and compressed before the agent's next compile.
    framework.pushEvent(channelMessage('m-asleep', `are you there?${filler}`, { triggerInference: false, wakeLater: 'sleep' }));
    for (let i = 0; i < 12; i++) framework.pushEvent(channelMessage(`m-${i}`, `chatter ${i}${filler}`, { triggerInference: false, tags: ['chat:ambient'] }));
    await framework.runUntilIdle();
    const asleep = ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source === 'mcpl:channel-incoming')!.messageId;
    assert.ok(ofType(traces, 'message:addressed').some((e) => e.messageId === asleep), 'premise: addressed');
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as { tick(): Promise<void> };
    for (let i = 0; i < 6; i++) await cm.tick();
    framework.pushEvent(channelMessage('m-now', 'and now?'));
    await framework.runUntilIdle();

    const sent = membrane.calls.map((r) => JSON.stringify(r.messages));
    assert.ok(sent.length > 0 && sent.every((t) => !t.includes('are you there?')), 'premise: no request carries it raw');
    assert.ok(sent.some((t) => t.includes('SUMMARY of the earlier talk')), 'premise: a request carries a summary');
    const request = ofType<{ delivered?: Delivery[] }>(traces, 'inference:request')[0]!;
    assert.deepEqual(request.delivered?.filter((d) => d.messageId === asleep), [{ messageId: asleep, form: 'summary' }]);
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant'), [], 'nothing left waiting');
    await framework.stop();
  });

  it("a summary covers what its sources do, level by level, each context manager's and branch's its own, and none where there's no archive", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    type Entries = Record<string, { sourceLevel: number; sourceIds: string[] }>;
    const archive = (initial: Entries) => {
      let entries = initial;
      let branch = { id: 'main', created: 1 };
      let lookups = 0;
      return {
        lookups: () => lookups,
        // A branch switch, as after an undo: the strategy mints its ids again.
        switchTo: (to: { id: string; created: number }, now: Entries) => { branch = to; entries = now; },
        currentBranch: () => branch,
        getSummary: (id: string) => { lookups++; return entries[id] ?? null; },
      };
    };
    const residents = archive({
      'L2-0': { sourceLevel: 1, sourceIds: ['L1-0', 'L1-1'] },
      'L1-0': { sourceLevel: 0, sourceIds: ['m-1', 'm-2'] },
      'L1-1': { sourceLevel: 0, sourceIds: ['m-3'] },
    });
    const fork = archive({ 'L1-0': { sourceLevel: 0, sourceIds: ['f-1'] } });
    assert.deepEqual([...fw.summaryCovers(residents, 'L2-0')].sort(), ['m-1', 'm-2', 'm-3']);
    assert.deepEqual([...fw.summaryCovers(fork, 'L1-0')], ['f-1'], "a fork's L1-0 isn't the residents'");
    const before = residents.lookups();
    assert.deepEqual([...fw.summaryCovers(residents, 'L1-0')].sort(), ['m-1', 'm-2']);
    assert.equal(residents.lookups(), before, 'read once per context manager and branch');
    residents.switchTo({ id: 'undone', created: 2 }, { 'L1-0': { sourceLevel: 0, sourceIds: ['m-7'] } });
    assert.deepEqual([...fw.summaryCovers(residents, 'L1-0')], ['m-7'], "another branch's L1-0 isn't the first branch's");
    // A branch is its id and its creation time together.
    residents.switchTo({ id: 'undone', created: 3 }, { 'L1-0': { sourceLevel: 0, sourceIds: ['m-8'] } });
    assert.deepEqual([...fw.summaryCovers(residents, 'L1-0')], ['m-8'], 'a branch made again under the same id is another branch');
    assert.deepEqual([...fw.summaryCovers(archive({}), 'L1-0')], [], 'no archive covers nothing');
    let broken = true;
    const flaky = {
      currentBranch: () => ({ id: 'main', created: 1 }),
      getSummary: (id: string) => { if (broken) throw new Error('stale branch'); return id === 'L1-0' ? { sourceLevel: 0, sourceIds: ['m-9'] } : null; },
    };
    assert.deepEqual([...fw.summaryCovers(flaky, 'L1-0')], [], 'a lookup that throws covers nothing');
    broken = false;
    assert.deepEqual([...fw.summaryCovers(flaky, 'L1-0')], ['m-9'], 'and is read again later');
    // A summary above one whose lookup threw isn't kept short either.
    let brokenBelow = true;
    const flakyBelow = {
      currentBranch: () => ({ id: 'main', created: 1 }),
      getSummary: (id: string) => {
        if (id === 'L2-0') return { sourceLevel: 1, sourceIds: ['L1-0'] };
        if (brokenBelow) throw new Error('stale branch');
        return { sourceLevel: 0, sourceIds: ['m-10'] };
      },
    };
    assert.deepEqual([...fw.summaryCovers(flakyBelow, 'L2-0')], [], 'its source threw');
    brokenBelow = false;
    assert.deepEqual([...fw.summaryCovers(flakyBelow, 'L2-0')], ['m-10'], 'read again once its source answers');
    // Nor one whose first source threw and whose last answered, nor one two
    // levels above a lookup that threw.
    let brokenFirst = true;
    const flakySiblings = {
      currentBranch: () => ({ id: 'main', created: 1 }),
      getSummary: (id: string) => {
        if (id === 'L3-0') return { sourceLevel: 2, sourceIds: ['L2-0'] };
        if (id === 'L2-0') return { sourceLevel: 1, sourceIds: ['L1-0', 'L1-1'] };
        if (id === 'L1-0' && brokenFirst) throw new Error('stale branch');
        return { sourceLevel: 0, sourceIds: [id === 'L1-0' ? 'm-11' : 'm-12'] };
      },
    };
    assert.deepEqual([...fw.summaryCovers(flakySiblings, 'L3-0')], ['m-12'], 'its first source threw');
    brokenFirst = false;
    assert.deepEqual([...fw.summaryCovers(flakySiblings, 'L3-0')].sort(), ['m-11', 'm-12'], 'read again, two levels up, once it answers');
    const looped = archive({ 'L2-0': { sourceLevel: 1, sourceIds: ['L2-0', 'L1-1'] }, 'L1-1': { sourceLevel: 0, sourceIds: ['m-3'] } });
    assert.deepEqual([...fw.summaryCovers(looped, 'L2-0')], ['m-3'], 'a summary among its own sources ends the walk');
    // A manager whose branch can't be read starts afresh each call, and its walk still ends.
    let unbranched = 0;
    const noBranch = {
      currentBranch: () => { throw new Error('no branch'); },
      getSummary: (id: string) => { unbranched++; return id === 'L2-0' ? { sourceLevel: 1, sourceIds: ['L2-0', 'L1-0'] } : { sourceLevel: 0, sourceIds: ['m-4'] }; },
    };
    assert.deepEqual([...fw.summaryCovers(noBranch, 'L2-0')], ['m-4']);
    const once = unbranched;
    fw.summaryCovers(noBranch, 'L2-0');
    assert.equal(unbranched, once * 2, 'read again each time');
    await framework.stop();
  });

  it('a request reads its summaries only while messages still wait once its raw ones are delivered', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    let lookups = 0;
    const cm = { getSummary: () => { lookups++; return { sourceLevel: 0, sourceIds: ['m-2'] }; } };
    const agent = { name: 'assistant', getContextManager: () => cm };
    fw.addressedMessages.add('assistant', 'm-1', 'assistant', true);
    assert.deepEqual(fw.deliverAddressed(agent, () => ['m-1'], false, undefined, () => ['L1-0']), whole('m-1'));
    assert.equal(lookups, 0, 'nothing left waiting, so no summary is read');
    fw.addressedMessages.add('assistant', 'm-2', 'assistant', true);
    fw.addressedMessages.add('assistant', 'm-3', 'assistant', true);
    fw.addressedMessages.add('assistant', 'm-4', 'assistant', true);
    assert.deepEqual(fw.deliverAddressed(agent, () => ['m-3'], false, undefined, () => ['L1-0']), [...whole('m-3'), { messageId: 'm-2', form: 'summary' }]);
    assert.equal(lookups, 1);
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant').map(([id]) => id), ['m-4'], 'one no summary covers still waits');
    // Each waiting message is looked up in what a summary covers; the
    // coverage, as long as the history it summarizes, isn't copied.
    const summaryCovers = fw.summaryCovers;
    fw.summaryCovers = () => ({ has: (id: string) => id === 'm-4', [Symbol.iterator]: () => { throw new Error('the coverage was copied'); } }) as unknown as ReadonlySet<string>;
    try {
      assert.deepEqual(fw.deliverAddressed(agent, () => [], false, undefined, () => ['L1-9']), [{ messageId: 'm-4', form: 'summary' }]);
    } finally {
      fw.summaryCovers = summaryCovers;
    }
    await framework.stop();
  });

  it('a message every request drops, its text all blank, is withdrawn, never delivered', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hm')])]]);
    const framework = await createFramework();
    framework.pushEvent(go('   '));
    await framework.runUntilIdle();
    const blank = ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source === 'external-message')!.messageId;
    assert.ok(ofType(traces, 'message:addressed').some((e) => e.messageId === blank), 'premise: addressed');
    assert.equal(membrane.calls.length, 1, 'premise: its turn sent a request');
    assert.ok(ofType<{ delivered?: Delivery[] }>(traces, 'inference:request').every((e) => !e.delivered?.some((d) => d.messageId === blank)), 'not delivered');
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[blank, 'dropped']]);
    await framework.stop();
  });

  it('in one compile, a blank message is withdrawn and the message after it delivered', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hm')])]]);
    module.adds = 2;
    const framework = await createFramework();
    framework.pushEvent(go('   '));
    await framework.runUntilIdle();
    const [blank, worded] = ofType<{ messageId: string; source: string }>(traces, 'message:added').filter((e) => e.source === 'external-message').map((e) => e.messageId);
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.messageId), [blank, worded], 'premise: both addressed');
    assert.equal(membrane.calls.length, 1, 'premise: one request');
    assert.deepEqual(ofType<{ delivered?: Delivery[] }>(traces, 'inference:request').map((e) => e.delivered), [whole(worded!)]);
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[blank, 'dropped']]);
    await framework.stop();
  });

  it('a write held while the host is quiesced is held by the quiesce', async () => {
    const framework = await createFramework();
    await framework.quiesce({ reason: 'surgery' });
    framework.pushEvent(channelMessage('m-q', 'during surgery'));
    await framework.runUntilIdle();
    const addressed = ofType(traces, 'message:addressed');
    assert.deepEqual(addressed.map((e) => e.held), ['quiesce']);
    await framework.stop();
  });

  it("a tune-out's diverted message is addressed to the subconscious", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'subconscious.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' }],
      subconscious: { enabled: true, systemPrompt: 'You watch tuned-out channels.' },
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    const fw = internals(framework);
    assert.equal(fw.subconsciousAgentName, 'Subconscious', 'premise');
    fw.tuneOutCoordinator = { onIncoming: () => ({ epochId: 'e1' }), stop: () => {} };
    framework.pushEvent(channelMessage('m-t', 'tuned out'));
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.agentName), ['Subconscious']);
    // A debounce batch's end wakes every agent but the subconscious, so a
    // message the batch holds isn't addressed to it, though it reads the slot.
    fw.tuneOutCoordinator = { onIncoming: () => null, stop: () => {} };
    framework.pushEvent(channelMessage('m-b', 'batched', { triggerInference: false, wakeLater: 'debounce' }));
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.agentName), ['Subconscious', 'assistant']);
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    framework.pushEvent(channelMessage('m-n', 'woken now'));
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.agentName), ['Subconscious', 'assistant', 'assistant']);
    assert.deepEqual(ofType(traces, 'inference:request').map((e) => e.agentName), ['assistant']);
    await framework.stop();
  });

  it("a self-wake's notice, a script's wake and a prose bounce are addressed", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    const fw = internals(framework);
    // A turn first, so the bounce has the turn's routing to read.
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const before = ofType(traces, 'message:addressed').length;
    const addressedSince = () => ofType<{ messageId: string; agentName: string }>(traces, 'message:addressed').slice(before);
    const addedFrom = (source: string) => ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source.startsWith(source))!;

    await fw.scriptWake('assistant', 's-1', 'the script finished', 'exit');
    fw.bounceProse(fw.agents.get('assistant'), 'hello there', 'no channel named #nowhere', undefined, '>>',
      { routing: fw.turnRouting.get('assistant'), notice: 'now' });
    fw.eventGate!.armSelfWake('assistant', 1);
    await until(() => addressedSince().length === 3, 'the self-wake', 30_000);
    assert.deepEqual(
      addressedSince().map((e) => [e.messageId, e.agentName]),
      [addedFrom('code-execution-script'), addedFrom('prose-bounce'), addedFrom('gate:self-wake')].map((e) => [e.messageId, 'assistant']),
    );
    await framework.stop();
  });

  it("a script's wake and a prose bounce held behind a live turn are named by their deferred ids", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const framework = await createFramework();
    const fw = internals(framework);
    module.during = async () => {
      await fw.scriptWake('assistant', 's-1', 'the script finished', 'exit');
      fw.bounceProse(fw.agents.get('assistant'), 'hello there', 'no channel named #nowhere', undefined, '>>',
        { routing: fw.turnRouting.get('assistant'), notice: 'now' });
    };
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const added = ofType<{ messageId: string; deferredId?: string; agentName?: string; source: string }>(traces, 'message:added')
      .filter((e) => e.source.startsWith('code-execution-script') || e.source === 'prose-bounce');
    assert.equal(added.length, 2);
    for (const e of added) {
      assert.deepEqual([e.messageId, e.agentName, typeof e.deferredId], ['', 'assistant', 'string'], e.source);
      assert.ok(ofType(traces, 'message:addressed').some((a) => a.messageId === e.deferredId), `${e.source} addressed by its deferred id`);
    }
    await framework.stop();
  });

  it('an addressed message leaves the record when its sender removes it, its agent goes, or it is no longer to be had', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    const framework = await createFramework();
    const fw = internals(framework);
    const cm = fw.agents.get('assistant')!.getContextManager();
    const removed = cm.addMessage('user', [text('withdrawn by its sender')]);
    const gone = cm.addMessage('user', [text('gone from the branch')]);
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: removed });
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: gone });
    // Held, then dropped from the queue unstored.
    fw.deferredMessages.push({ id: 'never-stored' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'never-stored' });
    fw.deferredMessages.length = 0;
    assert.equal(fw.removePlacement({ agent: 'assistant', messageId: removed }), true);
    // Taken from the store behind the record's back, as an undo would.
    removeStoredMessage(cm as unknown as ContextManager, gone as MessageId);
    framework.pushEvent(go());
    await framework.runUntilIdle();

    const withdrawn = ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]);
    assert.deepEqual(withdrawn, [[removed, 'removed'], ['never-stored', 'dropped'], [gone, 'branch-moved']]);
    await framework.stop();
  });

  it('a held write its sender removes leaves the record, and no boundary delivers it', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const framework = await createFramework();
    const fw = internals(framework);
    let removed: boolean | undefined;
    let deferredId: string | undefined;
    module.during = () => framework.pushEvent(channelMessage('m-mid', 'never mind'));
    module.deferred = () => {
      deferredId = ofType<{ deferredId?: string; source: string }>(traces, 'message:added')
        .find((e) => e.source === 'mcpl:channel-incoming')!.deferredId;
      removed = fw.removePlacement({ agent: 'assistant', deferredId });
    };
    framework.pushEvent(go());
    await framework.runUntilIdle();

    assert.ok(deferredId);
    assert.equal(removed, true);
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.agentName, e.reason]), [[deferredId, 'assistant', 'removed']]);
    assert.ok(ofType<{ delivered?: Delivery[] }>(traces, 'inference:stream_resumed').every((e) => e.delivered === undefined));
    await framework.stop();
  });

  it('a held write addressed to two residents is withdrawn for both, or found by its stored id for both once stored', async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'two-held.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' },
        { name: 'helper', model: 'test-model', systemPrompt: 'You help.', proseRouting: 'disabled', triggerSources: ['elsewhere'] },
      ],
      modules: [module],
    });
    module.framework = framework;
    framework.onTrace((event) => traces.push(event));
    module.wake = ['assistant'];
    const held = () => ofType<{ deferredId?: string; source: string }>(traces, 'message:added').filter((e) => e.source === 'mcpl:channel-incoming').map((e) => e.deferredId!);
    module.during = () => {
      framework.pushEvent(channelMessage('m-a', 'never mind'));
      framework.pushEvent(channelMessage('m-b', 'and this'));
    };
    module.deferred = async () => {
      await until(() => held().length === 2, 'both writes to be held');
      internals(framework).removePlacement({ agent: 'assistant', deferredId: held()[0] });
    };
    framework.pushEvent(go());
    await framework.runUntilIdle();

    const [removed, kept] = held();
    assert.deepEqual(ofType(traces, 'message:addressed').filter((e) => e.messageId === kept).map((e) => e.agentName), ['assistant', 'helper'], 'premise: addressed to both');
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.agentName, e.reason]), [[removed, 'assistant', 'removed'], [removed, 'helper', 'removed']]);
    // The assistant's boundary stores it and delivers it there. The helper's
    // turns for both ran while they were held behind the assistant's turn, so
    // for the helper it's still waiting, by its stored id.
    const resumed = ofType<{ agentName: string; delivered?: Delivery[] }>(traces, 'inference:stream_resumed').filter((e) => e.agentName === 'assistant');
    assert.deepEqual(resumed.flatMap((e) => e.delivered ?? []), whole(kept!));
    const waiting = internals(framework).addressedMessages.entriesOf('helper');
    assert.equal(waiting.length, 1);
    const [storedId, entry] = waiting[0]!;
    assert.notEqual(storedId, kept);
    assert.deepEqual(entry, { name: kept, storedIn: 'assistant', stored: true });
    assert.ok(framework.getAgent('assistant')!.getContextManager().getMessage(storedId as MessageId), 'found by the id it was stored under');
    await framework.stop();
  });

  it("a module's removal of a waiting message, stored or held, withdraws it", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const framework = await createFramework();
    const fw = internals(framework);
    const stored = fw.agents.get('assistant')!.getContextManager().addMessage('user', [text('taken back')]);
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: stored });
    fw.removeMessage(stored);
    let deferredId: string | undefined;
    module.during = () => framework.pushEvent(channelMessage('m-mid', 'never mind'));
    module.deferred = () => {
      deferredId = ofType<{ deferredId?: string; source: string }>(traces, 'message:added').find((e) => e.source === 'mcpl:channel-incoming')!.deferredId;
      fw.removeMessage(heldHandle(deferredId!));
    };
    framework.pushEvent(go());
    await framework.runUntilIdle();
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[stored, 'removed'], [deferredId, 'removed']]);
    await framework.stop();
  });

  it("a module's removal withdraws by the id the message waits under: a sharded body's by any shard's id, and a landed write's by its held handle", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'sharded.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled',
        strategy: Object.assign(new PassthroughStrategy(), {
          chunkIngressMessage: (_participant: string, content: Array<{ type: string; text?: string }>) => content[0]?.text === 'LONG'
            ? { bodyGroupId: 'long-body', shards: [{ shardIndex: 0, content: [text('LONG, part one')] }, { shardIndex: 1, content: [text('part two')] }] }
            : null,
        }),
      }],
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    const fw = internals(framework);
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as ContextManager;
    const head = cm.addMessage('user', [text('LONG')]);
    const second = cm.getMessageWindow(0, cm.getMessageCount()).messages.find((m) => m.id !== head)!;
    assert.equal(second.bodyGroupId, 'long-body', 'premise: a later shard of the body');
    // A held sharded write a drain stored before its wake's note is found by its first shard.
    const heldHead = cm.addMessage('user', [text('LONG')], { deferredWriteId: 'w-long' } as never);
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-long' });
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant').map(([id, e]) => [id, e.name]), [[heldHead, 'w-long']]);
    fw.addressedMessages.withdraw('assistant', heldHead);
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: head });
    fw.removeMessage(second.id);
    assert.equal(cm.getMessage(head), null, 'premise: the whole body is removed');
    // A held write that landed, recorded by its stored id as a drain leaves it.
    const landed = cm.addMessage('user', [text('landed')], { deferredWriteId: 'w-landed' } as never);
    fw.addressedMessages.add('assistant', landed, 'assistant', true);
    fw.removeMessage(heldHandle('w-landed'));
    // The coalescer's removal of a drained sharded write, which it finds by
    // its newest shard above the consumed watermark: withdrawn by the first.
    const coalesced = cm.addMessage('user', [text('LONG')], { deferredWriteId: 'w-coalesced' } as never);
    fw.addressedMessages.add('assistant', coalesced, 'assistant', true, 'w-coalesced');
    const reader = fw.agents.get('assistant')! as unknown as { getConsumedWatermark(): unknown };
    reader.getConsumedWatermark = () => ({ branch: cm.currentBranch().name, sequence: -1 });
    assert.equal((fw as unknown as { removePlacement(p: unknown): boolean }).removePlacement({ agent: 'assistant', deferredId: 'w-coalesced' }), true);
    assert.equal(cm.getMessage(coalesced as MessageId), null, 'premise: the whole body is removed');
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[head, 'removed'], [landed, 'removed'], ['w-coalesced', 'removed']]);
    await framework.stop();
  });

  it("a wake noted after its held write was stored is found by the stored id under its arrival's name; one still queued or unsearchable keeps its deferred id, and one gone isn't noted", async () => {
    const framework = await createFramework();
    const fw = internals(framework) as Internals & { landedRow(cm: unknown, writeId: string): unknown };
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as { addMessage(p: string, c: ContentBlock[], m?: unknown): string };
    // Stored by a drain before the note, so the drain's re-key found nothing to re-key.
    const stored = cm.addMessage('user', [text('stored meanwhile')], { deferredWriteId: 'w-stored' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-stored' });
    // Neither queued, stored, nor stored and not yet acked: gone, as a dropped write is.
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-nowhere' });
    // Queued, its landing unknown, and stored after all: found by its stored id.
    const maybe = cm.addMessage('user', [text('landed though unknown')], { deferredWriteId: 'w-unknown' });
    fw.deferredMessages.push({ id: 'w-unknown', landing: 'unknown' } as { id: string });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-unknown' });
    fw.deferredMessages.length = 0;
    // Queued, its landing unknown, and found nowhere: it keeps its deferred id.
    fw.deferredMessages.push({ id: 'w-doubtful', landing: 'unknown' } as { id: string });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-doubtful' });
    fw.deferredMessages.length = 0;
    // Stored and not yet acked, though no search finds it: it keeps its deferred id.
    fw.unackedDeferredWrites.push({ id: 'w-unacked' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-unacked' });
    fw.unackedDeferredWrites.length = 0;
    // Still queued: no store is searched for it.
    const landedRow = fw.landedRow;
    let searches = 0;
    fw.landedRow = (...args) => { searches++; return landedRow.apply(fw, args); };
    fw.deferredMessages.push({ id: 'w-queued' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-queued' });
    fw.deferredMessages.length = 0;
    assert.equal(searches, 0, 'a queued write is not searched for');
    // A store whose search throws.
    fw.landedRow = () => { throw new Error('the store is unreadable'); };
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-unsearchable' });
    fw.landedRow = landedRow;
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant'), [
      [stored, { name: 'w-stored', storedIn: 'assistant', stored: true }],
      [maybe, { name: 'w-unknown', storedIn: 'assistant', stored: true }],
      ['w-doubtful', { name: 'w-doubtful', storedIn: 'assistant', stored: false }],
      ['w-unacked', { name: 'w-unacked', storedIn: 'assistant', stored: false }],
      ['w-queued', { name: 'w-queued', storedIn: 'assistant', stored: false }],
      ['w-unsearchable', { name: 'w-unsearchable', storedIn: 'assistant', stored: false }],
    ]);
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.messageId), ['w-stored', 'w-unknown', 'w-doubtful', 'w-unacked', 'w-queued', 'w-unsearchable'], "named as their arrivals named them");
    await framework.stop();
  });

  it("a tune-out's diverted message is addressed to no agent but the subconscious, held, stored and not yet acked, or stored", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as { addMessage(p: string, c: ContentBlock[], m?: unknown): string };
    const tuneOut = { epochId: 'e1' };
    fw.deferredMessages.push({ id: 'w-held', metadata: { tuneOut } } as { id: string });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-held' });
    fw.unackedDeferredWrites.push({ id: 'w-flushed', metadata: { tuneOut } } as { id: string });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-flushed' });
    const row = cm.addMessage('user', [text('diverted')], { tuneOut });
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: row });
    // A held write a drain stored meanwhile, noted by its deferred id: found
    // stored first, then its row's stamp read.
    cm.addMessage('user', [text('diverted, then drained')], { tuneOut, deferredWriteId: 'w-drained' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-drained' });
    // A held write not diverted, for contrast.
    fw.deferredMessages.push({ id: 'w-plain' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'w-plain' });
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.messageId), ['w-plain']);
    fw.deferredMessages.length = 0;
    fw.unackedDeferredWrites.length = 0;
    await framework.stop();
  });

  it("a render's wake to read it addresses it unless a request already carried it and was answered", async () => {
    const framework = await createFramework();
    const fw = internals(framework) as Internals & {
      queueCoalescedWakes(occ: unknown, plain: boolean, readsDeferredWrite?: string, allAmbient?: boolean): Promise<void>;
      deferredWriteDone(agent: unknown, writeId: string, to: unknown): boolean;
      coalescedAudience(occ: unknown): Promise<string[]>;
    };
    const asked: Array<[string, unknown]> = [];
    let done = false;
    fw.deferredWriteDone = (_agent, writeId, to) => { asked.push([writeId, to]); return done; };
    const render = (deferredId: string, opts: { allAmbient?: boolean; scope?: { kind: string; id: string }; to?: string } = {}) => {
      fw.deferredMessages.push({ id: deferredId });
      const event = pushMessage('e-1', 'rendered');
      return fw.queueCoalescedWakes({
        serverId: 'feed', binding: 'b-1', scope: opts.scope ?? { kind: 'channel', id: 'chat:room' }, key: 'k', eventId: 'e-1',
        timestamp: new Date().toISOString(), retract: false, deferred: false, initial: true, content: [],
        event: { lane: 'push', event }, deliverTo: opts.to ?? 'assistant',
      }, true, deferredId, opts.allAmbient ?? false);
    };
    await render('w-render');
    done = true;
    await render('w-answered');
    // Asked with no channel for a render every notice of which was ambient,
    // and for one off any channel, as the scheduler asks.
    done = false;
    await render('w-ambient', { allAmbient: true });
    await render('w-feed', { scope: { kind: 'featureSet', id: 'feed.items' } });
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => e.messageId), ['w-render', 'w-ambient', 'w-feed']);
    const channel = { serverId: 'feed', channelId: 'chat:room' };
    assert.deepEqual(asked, [['w-render', channel], ['w-answered', channel], ['w-ambient', undefined], ['w-feed', undefined]], "asked as the scheduler asks it");
    // An audience member gone across the audience's await is asked nothing.
    const audience = fw.coalescedAudience;
    fw.coalescedAudience = async () => ['ghost'];
    try {
      await render('w-ghost');
    } finally {
      fw.coalescedAudience = audience;
    }
    assert.equal(asked.length, 4, 'nothing asked for an agent gone');
    fw.deferredMessages.length = 0;
    fw.pendingRequests.length = 0;
    await framework.stop();
  });

  it("an abort with no stream names the agent's turn only while it's live", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('hi')])]]);
    const framework = await createFramework();
    const fw = internals(framework) as Internals & { settledTurns: WeakSet<object> };
    framework.pushEvent(go());
    await framework.runUntilIdle();
    const agent = fw.agents.get('assistant')! as unknown as { abortInference(reason?: string): unknown; state: unknown };
    const routing = fw.turnRouting.get('assistant')! as unknown as { turnId: number };
    assert.ok(fw.settledTurns.has(routing), 'premise: the turn has settled');
    // A direct inference with no stream, after the framework's turn ended.
    const abort = agent.abortInference;
    agent.abortInference = () => ({ durationMs: 1 });
    try {
      framework.abortInference('assistant', 'operator');
      fw.settledTurns.delete(routing);
      framework.abortInference('assistant', 'operator');
    } finally {
      agent.abortInference = abort;
    }
    assert.deepEqual(ofType<{ turnId?: number }>(traces, 'inference:aborted').map((e) => e.turnId), [undefined, routing.turnId]);
    await framework.stop();
  });

  it("a compile finds a held entry its note missed stored, and keeps one whose store can't be searched", async () => {
    const framework = await createFramework();
    const fw = internals(framework) as Internals & { landedRow(cm: unknown, writeId: string): unknown };
    const agent = fw.agents.get('assistant')!;
    const cm = agent.getContextManager() as unknown as { addMessage(p: string, c: ContentBlock[], m?: unknown): string };
    fw.addressedMessages.add('assistant', 'w-landed', 'assistant', false);
    const stored = cm.addMessage('user', [text('stored with no re-key')], { deferredWriteId: 'w-landed' });
    fw.deliverAddressed(agent, () => [], true);
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant'), [[stored, { name: 'w-landed', storedIn: 'assistant', stored: true }]]);
    fw.addressedMessages.withdraw('assistant', stored);
    // Found by the compile whose request carries it, which delivers it.
    fw.addressedMessages.add('assistant', 'w-carried', 'assistant', false);
    const carried = cm.addMessage('user', [text('carried at once')], { deferredWriteId: 'w-carried' });
    assert.deepEqual(fw.deliverAddressed(agent, () => [carried], true), whole('w-carried'));
    // Queued, its landing unknown, and stored after all: the same.
    fw.addressedMessages.add('assistant', 'w-maybe', 'assistant', false);
    const maybe = cm.addMessage('user', [text('landed though unknown')], { deferredWriteId: 'w-maybe' });
    fw.deferredMessages.push({ id: 'w-maybe', landing: 'unknown' } as { id: string });
    assert.deepEqual(fw.deliverAddressed(agent, () => [maybe], true), whole('w-maybe'));
    fw.deferredMessages.length = 0;
    // One the request carries is delivered, though its window no longer
    // holds it by the time the request is traced (an undo during the
    // compile's awaits): delivery comes before withdrawal.
    const undone = cm.addMessage('user', [text('carried, then undone')]);
    fw.addressedMessages.add('assistant', undone, 'assistant', true);
    removeStoredMessage(cm as unknown as ContextManager, undone as MessageId);
    assert.deepEqual(fw.deliverAddressed(agent, () => [undone], true), whole(undone));
    // Stored and not yet acked, though not found: it waits.
    fw.unackedDeferredWrites.push({ id: 'w-unacked' });
    fw.addressedMessages.add('assistant', 'w-unacked', 'assistant', false);
    fw.deliverAddressed(agent, () => [], true);
    fw.unackedDeferredWrites.length = 0;
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant').map(([id]) => id), ['w-unacked']);
    fw.addressedMessages.withdraw('assistant', 'w-unacked');
    fw.addressedMessages.add('assistant', 'w-doubt', 'assistant', false);
    const landedRow = fw.landedRow;
    fw.landedRow = () => { throw new Error('the store is unreadable'); };
    try {
      fw.deliverAddressed(agent, () => [], true);
    } finally {
      fw.landedRow = landedRow;
    }
    assert.ok(fw.addressedMessages.entriesOf('assistant').some(([id]) => id === 'w-doubt'), 'kept while its store cannot be searched');
    assert.equal(ofType(traces, 'message:withdrawn').length, 0);
    await framework.stop();
  });

  it('nothing is addressed to an agent no longer registered', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    fw.noteAddressed('gone-fork', { agent: 'gone-fork', messageId: 'm-late' });
    fw.noteAddressed('gone-fork', { agent: 'assistant', messageId: 'm-late' });
    assert.equal(ofType(traces, 'message:addressed').length, 0);
    assert.deepEqual(fw.addressedMessages.entriesOf('gone-fork'), []);
    await framework.stop();
  });

  it('where the scheduler drops a wake and starts no turn, a waiting message no longer in its window is withdrawn', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as { addMessage(p: string, c: ContentBlock[]): string; removeMessage(id: string): void };
    const undone = cm.addMessage('user', [text('undone before its turn')]);
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: undone });
    cm.removeMessage(undone);
    // A wake whose write is gone too starts no turn (deferredWriteDone).
    fw.pendingRequests.push({ agentName: 'assistant', reason: 'test', source: 'test', timestamp: Date.now(), readsDeferredWrite: 'w-gone' });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 0, 'premise: no turn started');
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[undone, 'branch-moved']]);
    await framework.stop();
  });

  it('where the inference policy drops a wake, a waiting message no longer in its window is withdrawn', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'refusing.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' }],
      modules: [],
      inferencePolicy: { shouldInfer: () => false },
    });
    framework.onTrace((event) => traces.push(event));
    const fw = internals(framework);
    const cm = fw.agents.get('assistant')!.getContextManager() as unknown as { addMessage(p: string, c: ContentBlock[]): string; removeMessage(id: string): void };
    const undone = cm.addMessage('user', [text('undone before its turn')]);
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: undone });
    cm.removeMessage(undone);
    fw.pendingRequests.push({ agentName: 'assistant', reason: 'test', source: 'test', timestamp: Date.now() });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 0, 'premise: the policy dropped it');
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.reason]), [[undone, 'branch-moved']]);
    await framework.stop();
  });

  it("a continuation dropped after its open turn was cleared names the turn it ends", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    fw.turnRouting.set('assistant', { turnId: 77 });
    fw.endContinuedTurn('assistant', { kind: 'dropped', why: 'a test drops it' });
    assert.deepEqual(ofType(traces, 'inference:aborted').map((e) => e.turnId), [77]);
    await framework.stop();
  });

  it("a compile withdraws no held write still queued, and nothing whose window it can't read", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    const agent = fw.agents.get('assistant')!;
    const unreadable = agent.getContextManager().addMessage('user', [text('in a store that throws')]);
    fw.deferredMessages.push({ id: 'held-q' });
    fw.noteAddressed('assistant', { agent: 'assistant', deferredId: 'held-q' });
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: unreadable });
    const cm = agent.getContextManager() as unknown as { getMessage(id: string): unknown };
    const getMessage = cm.getMessage;
    cm.getMessage = () => { throw new Error('the store is unreadable'); };
    try {
      fw.deliverAddressed(agent, () => [], true);
    } finally {
      cm.getMessage = getMessage;
      fw.deferredMessages.length = 0;
    }
    assert.equal(ofType(traces, 'message:withdrawn').length, 0);
    assert.deepEqual(fw.addressedMessages.entriesOf('assistant').map(([id]) => id), ['held-q', unreadable]);
    await framework.stop();
  });

  it('a render the coalescer places in a deferred queue is addressed by its wake, and a channel-scoped push keeps the wake the gate holds', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    const occurrence = (event: ProcessEvent) => ({
      serverId: 'feed', binding: 'b-1', scope: { kind: 'channel', id: 'chat:room' }, key: 'k', eventId: 'e-1',
      timestamp: new Date().toISOString(), retract: false, deferred: false, initial: true, content: [],
      event: { lane: 'push', event },
    });
    fw.deferredMessages.push({ id: 'render-held' });
    await fw.queueCoalescedWakes({ ...occurrence(pushMessage('e-1', 'a render')), deliverTo: 'assistant' }, true, 'render-held');
    fw.deferredMessages.length = 0;
    await fw.deliverCoalesced(occurrence(pushMessage('e-2', 'held by the sleep', { triggerInference: false, wakeLater: 'sleep' })));
    const stored = ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source === 'mcpl:channel-incoming')!.messageId;
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName, e.held]), [['render-held', 'assistant', undefined], [stored, 'assistant', 'sleep']]);
    await framework.stop();
  });

  it('a push materialized for the request its wake started is addressed to that agent there, without the wake a gate held for it', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    const occurrence = (event: ProcessEvent, scope: { kind: string; id: string }) => ({
      serverId: 'feed', binding: 'b-1', scope, key: 'k', eventId: (event as { eventId: string }).eventId,
      timestamp: new Date().toISOString(), retract: false, deferred: false, initial: true, content: [],
      event: { lane: 'push', event },
    });
    const channel = { kind: 'channel', id: 'chat:room' };
    // On a channel: a wake asked now, and one the sleep held (the gate's
    // verdict: no wake now, a wake later); and off any channel.
    await fw.deliverCoalesced(occurrence(pushMessage('e-1', 'on the channel'), channel), undefined, 'assistant');
    await fw.deliverCoalesced(occurrence(pushMessage('e-2', 'held by the sleep', { triggerInference: false, wakeLater: 'sleep' }), channel), undefined, 'assistant');
    await fw.deliverCoalesced(occurrence(pushMessage('e-3', 'off any channel'), { kind: 'featureSet', id: 'feed.items' }), undefined, 'assistant');
    // Ones whose push asked no wake aren't, on a channel or off one.
    await fw.deliverCoalesced(occurrence(pushMessage('e-4', 'no wake', { triggerInference: false }), channel), undefined, 'assistant');
    await fw.deliverCoalesced(occurrence(pushMessage('e-5', 'no wake', { triggerInference: false }), { kind: 'featureSet', id: 'feed.items' }), undefined, 'assistant');
    // Nor one a tune-out diverts out of the resident's view.
    fw.tuneOutCoordinator = { onIncoming: () => ({ epochId: 'e1' }), stop: () => {} };
    await fw.deliverCoalesced(occurrence(pushMessage('e-6', 'diverted'), channel), undefined, 'assistant');
    fw.tuneOutCoordinator = null;
    // Off any channel, one the sleep held is answered there as on one: the
    // wake it held isn't repeated.
    await fw.deliverCoalesced(occurrence(pushMessage('e-7', 'held off any channel', { triggerInference: false, wakeLater: 'sleep' }), { kind: 'featureSet', id: 'feed.items' }), undefined, 'assistant');
    const stored = ofType<{ messageId: string; source: string }>(traces, 'message:added')
      .filter((e) => e.source === 'mcpl:channel-incoming' || e.source === 'mcpl:push-event').map((e) => e.messageId);
    assert.equal(stored.length, 7, 'premise: each stored');
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName, e.held]),
      [[stored[0], 'assistant', undefined], [stored[1], 'assistant', undefined], [stored[2], 'assistant', undefined], [stored[6], 'assistant', undefined]]);
    await framework.stop();
  });

  it("an ephemeral run's waiting messages are withdrawn when it ends", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('done')])]]);
    const framework = await createFramework();
    framework.start();
    const fw = internals(framework);
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
    });
    contextManager.addMessage('user', [text('Run once.')]);
    // Recorded behind the record's back, in a window the run's compile doesn't read.
    const elsewhere = [1, 2].map((n) => fw.agents.get('assistant')!.getContextManager().addMessage('user', [text(`for the worker ${n}`)]));
    for (const id of elsewhere) fw.addressedMessages.add('worker', id, 'assistant', true);
    await framework.runEphemeralToCompletion(agent, contextManager);
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.agentName, e.reason]),
      elsewhere.map((id) => [id, 'worker', 'agent-gone']));
    await framework.stop();
  });

  it("a message past the agent's bound is addressed as untracked, each time its wake is asked", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    for (let i = 0; i <= AddressedMessages.LIMIT_PER_AGENT; i++) fw.noteAddressed('assistant', { agent: 'assistant', messageId: `m-${i}` });
    // Asked again: nothing past the bound is remembered, so it's said again.
    fw.noteAddressed('assistant', { agent: 'assistant', messageId: `m-${AddressedMessages.LIMIT_PER_AGENT}` });
    const addressed = ofType<{ messageId: string; untracked?: true }>(traces, 'message:addressed');
    assert.equal(addressed.length, AddressedMessages.LIMIT_PER_AGENT + 2);
    assert.deepEqual(addressed.filter((e) => e.untracked).map((e) => e.messageId), [`m-${AddressedMessages.LIMIT_PER_AGENT}`, `m-${AddressedMessages.LIMIT_PER_AGENT}`]);
    await framework.stop();
  });

  it("a module's message is addressed to each woken agent that reads the residents' slot it's stored in, and delivered to each", async () => {
    scheduleTurns(membrane, []);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'two.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' },
        { name: 'helper', model: 'test-model', systemPrompt: 'You help.', proseRouting: 'disabled' },
      ],
      modules: [module],
    });
    module.framework = framework;
    framework.onTrace((event) => traces.push(event));
    framework.pushEvent(go('for everyone'));
    await framework.runUntilIdle();
    const added = ofType<{ agentName?: string; source: string }>(traces, 'message:added').filter((e) => e.source === 'external-message');
    assert.deepEqual(added.map((e) => e.agentName), ['assistant'], 'stored in the primary window');
    assert.deepEqual(new Set(ofType<{ agentName: string }>(traces, 'inference:started').map((e) => e.agentName)), new Set(['assistant', 'helper']), 'both woken');
    const id = ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source === 'external-message')!.messageId;
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName]), [[id, 'assistant'], [id, 'helper']]);
    assert.deepEqual(
      ofType<{ agentName: string; delivered?: Delivery[] }>(traces, 'inference:request').map((e) => [e.agentName, e.delivered]).sort(),
      [['assistant', whole(id)], ['helper', whole(id)]],
    );
    await framework.stop();
  });

  it('the record holds at most 1,000 messages for an agent, each once', () => {
    assert.equal(AddressedMessages.LIMIT_PER_AGENT, 1000);
    const record = new AddressedMessages();
    for (let i = 0; i < AddressedMessages.LIMIT_PER_AGENT; i++) assert.equal(record.add('a', `m-${i}`, 'a', true), 'added');
    assert.equal(record.add('a', 'm-0', 'a', true), 'present');
    assert.equal(record.add('a', 'one-more', 'a', true), 'full');
    assert.equal(record.add('b', 'another agent', 'b', true), 'added');
    assert.deepEqual(record.deliver('a', ['m-0', 'one-more']), ['m-0']);
    assert.equal(record.add('a', 'room again', 'a', true), 'added');
  });

  it("a held write keeps its name once it's stored", () => {
    const record = new AddressedMessages();
    record.add('a', 'held-1', 'a', false);
    record.stored('held-1', 'stored-1');
    assert.deepEqual(record.entriesOf('a'), [['stored-1', { name: 'held-1', storedIn: 'a', stored: true }]]);
    assert.deepEqual(record.deliver('a', ['stored-1']), ['held-1']);
    assert.equal(record.has('a'), false);
  });

  it('a request carries the raw bodies and the summaries of the messages it keeps, whole or in part, and drops the rest', () => {
    const provenance = { messages: [
      { kind: 'raw', bodies: [{ messageId: 'whole' }, { messageId: 'part-of-a-merge' }] },
      { kind: 'summary', summaries: [{ id: 'L1-0' }, { id: 'L2-1' }] },
      { kind: 'raw', bodies: [{ messageId: 'cut', complete: false }] },
      { kind: 'raw', bodies: [{ messageId: 'blank' }, { messageId: 'whole' }] },
      { kind: 'summary', summaries: [{ id: 'L1-9' }] },
    ] };
    assert.deepEqual(carriedBodies(provenance, new Set([0, 1, 2])), {
      carried: ['whole', 'part-of-a-merge', 'cut'], dropped: ['blank'], summaries: ['L1-0', 'L2-1'],
    });
  });

  // ---------------------------------------------------------------------------
  // Holds

  it("a sleep's set names its end, and wake ending it early is traced", async () => {
    const framework = await createFramework({ gate: { policies: [], default: 'always' } });
    const fw = internals(framework);
    const { until: end } = fw.eventGate!.setSleep(600, undefined, 'assistant');
    const set = ofType(traces, 'gate:decision').find((e) => e.eventType === 'sleep:set')!;
    assert.equal(set.until, end);
    fw.dispatchSleepToolCall('assistant', toolCall('w-1', 'wake'));
    await until(() => traces.some((e) => e.type === 'gate:decision' && (e as { eventType: string }).eventType === 'sleep:cleared'), 'the early end');
    assert.equal(fw.eventGate!.clearSleep(), false, 'no sleep left');
    assert.equal(ofType(traces, 'gate:decision').filter((e) => e.eventType === 'sleep:cleared').length, 1, 'only an ended sleep is traced');
    await framework.stop();
  });
});

describe("fleet telemetry facts on a channel's fork", () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let traces: TraceEvent[];
  const fork = forkAgentName('conversation', 'chat', 'chat:room', 1);
  const mentioned = (messageId: string, body: string, extra: Record<string, unknown> = {}) =>
    channelMessage(messageId, body, { metadata: { mentioned: true }, ...extra });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'telemetry-forks-'));
    membrane = new MockMembrane();
    // Every turn a fork starts answers and ends.
    scheduleTurns(membrane, []);
    traces = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.', proseRouting: 'disabled' }],
      modules: [],
      conversations: { templateAgent: 'trunk' },
    });
    framework.onTrace((event) => traces.push(event));
    return framework;
  }
  const addedTo = (agentName: string) => ofType<{ messageId: string; agentName?: string; source: string }>(traces, 'message:added')
    .filter((e) => e.source === 'mcpl:channel-incoming' && e.agentName === agentName).map((e) => e.messageId);

  it("a message the router wakes the fork for is addressed to the fork, and one a batch holds; one the sleep holds only where the router would wake it", async () => {
    const framework = await createFramework();
    framework.pushEvent(mentioned('m-1', 'hello'));
    await framework.runUntilIdle();
    framework.pushEvent(mentioned('m-2', 'after the sleep', { triggerInference: false, wakeLater: 'sleep' }));
    framework.pushEvent(mentioned('m-3', 'in the batch', { triggerInference: false, wakeLater: 'debounce' }));
    // Not mentioned, so the router wouldn't wake the fork; a batch's end
    // wakes every agent but the subconscious, forks included, and the sleep holds
    // only the router's wake.
    framework.pushEvent(channelMessage('m-4', 'chatter', { triggerInference: false, wakeLater: 'debounce' }));
    framework.pushEvent(channelMessage('m-5', 'chatter asleep', { triggerInference: false, wakeLater: 'sleep' }));
    framework.pushEvent(mentioned('m-6', 'vetoed', { triggerInference: false }));
    await framework.runUntilIdle();

    const stored = addedTo(fork);
    assert.equal(stored.length, 6);
    assert.deepEqual(
      ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName, e.held]),
      [[stored[0], fork, undefined], [stored[1], fork, 'sleep'], [stored[2], fork, undefined], [stored[3], fork, undefined]],
    );
    assert.deepEqual(ofType<{ delivered?: Delivery[] }>(traces, 'inference:request')[0]!.delivered, whole(stored[0]!));
    await framework.stop();
  });

  it("a push the gate batches in the trunk's window isn't addressed to a live fork, which the batch's end wakes but whose window doesn't hold it", async () => {
    const framework = await createFramework();
    framework.pushEvent(mentioned('m-1', 'hello'));
    await framework.runUntilIdle();
    assert.ok(internals(framework).agents.has(fork), 'premise: the fork is live');
    framework.pushEvent(pushMessage('p-1', 'in the batch', { triggerInference: false, wakeLater: 'debounce' }));
    await framework.runUntilIdle();
    const pushed = ofType<{ messageId: string; agentName?: string; source: string }>(traces, 'message:added').find((e) => e.source === 'mcpl:push-event')!;
    assert.equal(pushed.agentName, 'trunk', "premise: stored in the trunk's window");
    assert.deepEqual(ofType(traces, 'message:addressed').filter((e) => e.messageId === pushed.messageId).map((e) => e.agentName), ['trunk']);
    await framework.stop();
  });

  it('a push woken for at once, naming no agent, wakes the trunk alone while a fork is live, and is addressed to it', async () => {
    const framework = await createFramework();
    framework.pushEvent(mentioned('m-1', 'hello'));
    await framework.runUntilIdle();
    assert.ok(internals(framework).agents.has(fork), 'premise: the fork is live');
    const before = ofType(traces, 'inference:request').length;
    framework.pushEvent(pushMessage('p-1', 'for whoever is home'));
    await framework.runUntilIdle();
    const pushed = ofType<{ messageId: string; source: string }>(traces, 'message:added').find((e) => e.source === 'mcpl:push-event')!;
    assert.deepEqual(ofType(traces, 'message:addressed').filter((e) => e.messageId === pushed.messageId).map((e) => e.agentName), ['trunk']);
    assert.deepEqual(ofType(traces, 'inference:request').slice(before).map((e) => e.agentName), ['trunk']);
    await framework.stop();
  });

  it('a correction delivered to a fork is addressed to it when it asks a wake, now or later', async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    await fw.handleMcplChannelIncoming({ ...mentioned('m-1', 'first'), triggerInference: false });
    const deliver = (messageId: string, extra: Record<string, unknown>) =>
      fw.handleMcplChannelIncoming({ ...channelMessage(messageId, `corrected ${messageId}`), deliverTo: fork, ...extra });
    await deliver('m-2', { triggerInference: true });
    await deliver('m-3', { triggerInference: false, wakeLater: 'sleep' });
    await deliver('m-4', { triggerInference: false });

    const stored = addedTo(fork);
    assert.equal(stored.length, 4);
    assert.deepEqual(
      ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName, e.held]),
      [[stored[1], fork, undefined], [stored[2], fork, 'sleep']],
    );
    await framework.stop();
  });

  it("a tool batch's failed hook is traced in the batch's turn, though its fork is disposed meanwhile", async () => {
    scheduleTurns(membrane, [[createMockResponse([text('checking'), call('c1', 'hold--wait')], 'tool_use'), createMockResponse([text('done')])]]);
    const hold = new HoldModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'hooked.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.', proseRouting: 'disabled' }],
      modules: [hold],
      conversations: { templateAgent: 'trunk' },
    });
    hold.framework = framework;
    framework.onTrace((event) => traces.push(event));
    let hooked!: () => void;
    const reached = new Promise<void>((resolve) => { hooked = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    hold.batchHook = async () => {
      hooked();
      await released;
      throw new Error('the scan failed');
    };
    framework.pushEvent(mentioned('m-1', 'please check'));
    const running = framework.runUntilIdle();
    await reached;
    internals(framework).disposeConversationAgent(fork);
    release();
    await running;
    const turn = ofType<{ turnId?: number; agentName: string }>(traces, 'inference:started').find((e) => e.agentName === fork)?.turnId;
    assert.equal(typeof turn, 'number', "premise: the fork's turn has an id");
    assert.deepEqual(ofType(traces, 'module:batch_hook_failed').map((e) => [e.agentName, e.turnId]), [[fork, turn]]);
    await framework.stop();
  });

  it("a fork's waiting messages are withdrawn when it is disposed", async () => {
    const framework = await createFramework();
    const fw = internals(framework);
    await fw.handleMcplChannelIncoming({ ...mentioned('m-1', 'first'), triggerInference: false });
    assert.ok(fw.agents.has(fork));
    // Recorded behind the record's back, so nothing the fork compiles carries them.
    for (const id of ['for-the-fork-1', 'for-the-fork-2']) fw.addressedMessages.add(fork, id, fork, false);
    fw.disposeConversationAgent(fork);
    assert.deepEqual(ofType(traces, 'message:withdrawn').map((e) => [e.messageId, e.agentName, e.reason]),
      [['for-the-fork-1', fork, 'agent-gone'], ['for-the-fork-2', fork, 'agent-gone']]);
    await framework.stop();
  });

  it("an idle fork's closure prompt is stored, traced and addressed to it", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'idle.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.', proseRouting: 'disabled' }],
      modules: [],
      conversations: { templateAgent: 'trunk', idleTtlMs: 60_000 },
    });
    framework.onTrace((event) => traces.push(event));
    const fw = internals(framework);
    await fw.handleMcplChannelIncoming({ ...mentioned('m-1', 'first'), triggerInference: false });
    assert.ok(fw.agents.has(fork));
    forceExpiry(framework, { serverId: 'chat', channelId: 'chat:room' }, 60_000);
    fw.sweepExpiredConversations();
    const closure = ofType<{ messageId: string; agentName?: string; source: string }>(traces, 'message:added').filter((e) => e.source === 'conversation:closure');
    assert.deepEqual(closure.map((e) => e.agentName), [fork]);
    assert.deepEqual(ofType(traces, 'message:addressed').map((e) => [e.messageId, e.agentName]), [[closure[0]!.messageId, fork]]);
    await framework.stop();
  });
});

describe('fleet telemetry facts over a real MCPL child', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
  let tempDir: string | undefined;
  let framework: AgentFramework | undefined;

  afterEach(async () => {
    await framework?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    framework = undefined;
    tempDir = undefined;
  });

  it("a channel message and a push the framework's gate wakes for later are addressed, the sleep's held by it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'telemetry-mcpl-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    const traces: TraceEvent[] = [];
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
      gate: { config: { default: 'skip', policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] }, behavior: { debounce: 600_000 } }] } },
      mcplServers: [{
        id: 'discord', command: process.execPath, args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    framework.onTrace((event) => traces.push(event));
    await framework.start();
    const fw = framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] }; eventGate: EventGate };
    await until(() => fw.channelRegistry.listChannelsRaw().length >= 2, 'channel registration', 15_000);
    const addressed = () => ofType<{ messageId: string; agentName: string; held?: string }>(traces, 'message:addressed');
    const storedFrom = (source: string) => ofType<{ messageId: string; source: string }>(traces, 'message:added').filter((e) => e.source === source).map((e) => e.messageId);
    const send = async (line: string, count: number): Promise<void> => {
      appendFileSync(commandPath, `${line}\n`);
      await until(() => addressed().length >= count, `${line.split(' ')[0]} to be addressed`, 15_000);
    };
    await send('incoming discord:g1:room m-1 addressed hello', 1);
    await send(`push ${JSON.stringify({
      featureSet: 'chat', timestamp: new Date().toISOString(), eventId: 'ev-1',
      origin: { source: 'discord', messageId: 'ev-1', guildId: 'g1', channelId: 'room', mcplChannelId: 'discord:g1:room', authorId: 'U-other', authorName: 'someone', isMention: true, isDM: false },
      tags: ['chat:mention', 'chat:addressed', 'chat:from-human'],
      payload: { content: [{ type: 'text', text: 'hello again' }] },
    })}`, 2);
    fw.eventGate.setSleep(600, undefined, 'scout');
    await send('incoming discord:g1:room m-2 addressed while asleep', 3);
    const incoming = storedFrom('mcpl:channel-incoming');
    assert.deepEqual(addressed().map((e) => [e.messageId, e.agentName, e.held]), [
      [incoming[0], 'scout', undefined], [storedFrom('mcpl:push-event')[0], 'scout', undefined], [incoming[1], 'scout', 'sleep'],
    ]);
  });
});

describe("the gate's verdict on an inbound message", () => {
  const gateWith = (config: GateConfig) => new EventGate({
    configPath: join(mkdtempSync(join(tmpdir(), 'gate-verdict-')), 'gate.json'),
    initialConfig: config,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
  const message = { eventType: 'mcpl:channel-incoming', serverId: 'chat', channelId: 'room', tags: ['chat:addressed'] };

  it('is a wake now, none, a debounce batch, or the sleep', () => {
    assert.equal(gateWith({ policies: [], default: 'always' }).triggerVerdictCallback()('hi', message), true);
    assert.equal(gateWith({ policies: [], default: 'defer' }).triggerVerdictCallback()('hi', message), false);
    const batching = gateWith({ policies: [{ name: 'batch', match: {}, behavior: { debounce: 60_000 } }], default: 'always' });
    assert.deepEqual(batching.triggerVerdictCallback()('hi', message), { trigger: false, later: 'debounce' });
    assert.equal(batching.asShouldTriggerCallback()('hi', message), false, "the host's boolean callback says no wake now");
    const sleeping = gateWith({ policies: [], default: 'always' });
    sleeping.setSleep(600);
    assert.deepEqual(sleeping.triggerVerdictCallback()('hi', message), { trigger: false, later: 'sleep' });
    for (const gate of [batching, sleeping]) gate.dispose();
  });

  it("is none for a rate limit's denial or a sample's miss", () => {
    const limited = gateWith({ policies: [{ name: 'limit', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000 } } }], default: 'always' });
    assert.equal(limited.triggerVerdictCallback()('hi', message), true, 'the first takes the token');
    assert.equal(limited.triggerVerdictCallback()('hi', message), false, 'the next is denied');
    const sampled = gateWith({ policies: [{ name: 'sample', match: {}, behavior: { passive_sample: { every: 3 } } }], default: 'always' });
    assert.equal(sampled.triggerVerdictCallback()('hi', message), false, 'a miss');
    for (const gate of [limited, sampled]) gate.dispose();
  });

  it("during a sleep, holds the wake unless the matching rule is a defer or a skip, rate limits and samples whatever their state, and every wake while a loaded gate.js decides", async () => {
    let clock = Date.now();
    const asleep = (config: GateConfig, script?: string): { gate: EventGate; dir: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-verdict-'));
      if (script) writeFileSync(join(dir, 'gate.js'), script);
      const gate = new EventGate({
        configPath: join(dir, 'gate.json'), initialConfig: config, emitTrace: () => {}, addMessage: () => '',
        requestInference: () => {}, getAgentNames: () => ['agent'], now: () => clock,
      });
      gate.setSleep(600);
      return { gate, dir };
    };
    const held = { trigger: false, later: 'sleep' };
    const limit = { name: 'limit', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000 } } };
    const gates = {
      deferByDefault: asleep({ policies: [], default: 'defer' }),
      skipByRule: asleep({ policies: [{ name: 'quiet', match: {}, behavior: 'skip' }], default: 'always' }),
      deferByRule: asleep({ policies: [{ name: 'later', match: {}, behavior: 'defer' }], default: 'always' }),
      limited: asleep({ policies: [limit], default: 'defer' }),
      // Its one token spent before the sleep.
      spent: asleep({ policies: [limit], default: 'defer' }),
      // A sampler that wouldn't fire for this message.
      sampled: asleep({ policies: [{ name: 'sample', match: {}, behavior: { passive_sample: { every: 3 } } }], default: 'defer' }),
      // One with passthrough falls through to the rule after it: the default's defer, or a wake.
      sampledPastToDefer: asleep({ policies: [{ name: 'sample', match: {}, behavior: { passive_sample: { every: 3 } }, passthrough: true }], default: 'defer' }),
      sampledPastToWake: asleep({ policies: [
        { name: 'sample', match: {}, behavior: { passive_sample: { every: 3 } }, passthrough: true },
        { name: 'wake', match: {}, behavior: 'always' },
      ], default: 'defer' }),
      // A passthrough limit with its token matches; spent, it falls through to the default's defer.
      limitedPast: asleep({ policies: [{ ...limit, passthrough: true }], default: 'defer' }),
      spentPast: asleep({ policies: [{ ...limit, passthrough: true }], default: 'defer' }),
      scripted: asleep({ policies: [], default: 'defer' }, `export default () => null;`),
      // A gate.js that loads with no decision function falls through to the
      // policies, as does one whose import fails with an empty message.
      broken: asleep({ policies: [], default: 'defer' }, `export const notAFunction = 1;`),
      silentlyBroken: asleep({ policies: [], default: 'defer' }, `throw new Error('');`),
      // One whose worker dies after it first loaded.
      dying: asleep({ policies: [], default: 'defer' }, [
        `import { existsSync, writeFileSync } from 'node:fs';`,
        `const died = new URL('./died', import.meta.url);`,
        `if (!existsSync(died)) { writeFileSync(died, ''); setTimeout(() => { throw new Error('later'); }, 50); }`,
        `export default () => null;`,
      ].join('\n')),
      removed: asleep({ policies: [], default: 'defer' }, `export default () => null;`),
      edited: asleep({ policies: [], default: 'defer' }, `export default () => null;`),
      replaced: asleep({ policies: [], default: 'defer' }, `export default () => null;`),
    };
    const verdict = (g: { gate: EventGate }) => g.gate.triggerVerdictCallback()('hi', message);
    try {
      for (const g of [gates.spent, gates.spentPast]) {
        g.gate.clearSleep();
        assert.equal(verdict(g), true, 'premise: the token is taken awake');
        g.gate.setSleep(600);
      }
      // Each asked twice: the sleep's check spends nothing, so its answer holds.
      for (let i = 0; i < 2; i++) {
        assert.equal(verdict(gates.deferByDefault), false);
        assert.equal(verdict(gates.skipByRule), false);
        assert.equal(verdict(gates.deferByRule), false);
        assert.deepEqual(verdict(gates.limited), held);
        assert.deepEqual(verdict(gates.spent), held, 'a spent bucket is held too');
        assert.deepEqual(verdict(gates.sampled), held, 'a sampler that would miss is held');
        assert.equal(verdict(gates.sampledPastToDefer), false);
        assert.deepEqual(verdict(gates.sampledPastToWake), held);
        assert.deepEqual(verdict(gates.limitedPast), held);
        assert.equal(verdict(gates.spentPast), false, 'a spent passthrough limit falls through to the defer');
      }
      // Awake, the limit still has its token, and the sampler its count.
      gates.limited.gate.clearSleep();
      assert.equal(verdict(gates.limited), true, "the sleep's checks spent no token");
      assert.equal(verdict(gates.limited), false);
      gates.sampled.gate.clearSleep();
      assert.deepEqual([verdict(gates.sampled), verdict(gates.sampled), verdict(gates.sampled)], [false, false, true], "the sleep's checks advanced no count");

      for (const g of [gates.scripted, gates.broken, gates.silentlyBroken, gates.dying, gates.removed, gates.edited, gates.replaced]) {
        await until(() => g.gate.getStatus().script.ready, 'gate.js to load', 15_000);
      }
      assert.equal(gates.scripted.gate.getStatus().script.lastError, null, 'premise: gate.js loaded');
      assert.deepEqual(verdict(gates.scripted), held);
      assert.ok(gates.broken.gate.getStatus().script.lastError, "premise: gate.js loaded with no decision function");
      assert.equal(verdict(gates.broken), false, 'a broken gate.js decides nothing, so the default defer gives no wake');
      assert.equal(verdict(gates.silentlyBroken), false, 'nor one whose import failed with an empty message');
      assert.ok(gates.silentlyBroken.gate.getStatus().script.lastError, 'whose failure its status still reports');
      await until(() => gates.dying.gate.getStatus().script.lastError === 'later', 'the worker to die', 15_000);
      await until(() => verdict(gates.dying) === false, "the worker's exit to be seen", 5_000);
      // Awake, the next event finds the dead worker unanswering and respawns
      // it, as a wedged one, and the respawned gate.js decides again.
      gates.dying.gate.clearSleep();
      verdict(gates.dying);
      gates.dying.gate.setSleep(600);
      await until(() => JSON.stringify(verdict(gates.dying)) === JSON.stringify(held), 'the respawned gate.js to decide', 15_000);
      // Past the reload's throttle, as the clock goes on during a sleep.
      for (const g of [gates.removed, gates.edited, gates.replaced]) assert.deepEqual(verdict(g), held, 'premise: held while its gate.js decides');
      type ScriptWorker = { threadId: number; once(event: 'exit', listener: () => void): void; listeners(event: 'exit'): Array<(code: number) => void> };
      const replacedWorker = (gates.replaced.gate as unknown as { gateScript: { worker?: ScriptWorker } }).gateScript.worker!;
      // Its exit listeners, taken while it runs: Node drops them once it has exited.
      const replacedExit = replacedWorker.listeners('exit');
      const editedWorker = (gates.edited.gate as unknown as { gateScript: { worker?: ScriptWorker & { emit(event: 'message', m: unknown): void } } }).gateScript.worker!;
      rmSync(join(gates.removed.dir, 'gate.js'));
      writeFileSync(join(gates.edited.dir, 'gate.js'), `export const notAFunction = 2;`);
      writeFileSync(join(gates.replaced.dir, 'gate.js'), `export default () => null; // replaced`);
      clock += 60_000;
      assert.equal(verdict(gates.removed), false, 'gate.js removed during the sleep no longer decides');
      assert.equal(verdict(gates.edited), false, 'nor does one edited during the sleep while it reloads');
      // A load its old worker, still stopping, reports late speaks for nothing.
      editedWorker.emit('message', { type: 'ready', error: null });
      assert.equal(verdict(gates.edited), false, "nor after its old worker's late report of a load");
      await until(() => gates.edited.gate.getStatus().script.ready, 'the edited gate.js to load', 15_000);
      assert.equal(verdict(gates.edited), false, 'nor once it has loaded with no decision function');
      // A gate.js replaced by one that decides holds again, its old worker's
      // exit, which comes after, changing nothing.
      assert.equal(verdict(gates.replaced), false, 'premise: reloading');
      await until(() => gates.replaced.gate.getStatus().script.ready, 'the replaced gate.js to load', 15_000);
      if (replacedWorker.threadId !== -1) await new Promise<void>((resolve) => replacedWorker.once('exit', resolve));
      assert.deepEqual(verdict(gates.replaced), held, "its old worker's exit leaves the new one deciding");
      // However late that exit is reported, after the new one has loaded.
      for (const listener of replacedExit) listener(1);
      assert.deepEqual(verdict(gates.replaced), held, "an exit of its old worker reported late leaves the new one deciding");
    } finally {
      for (const g of Object.values(gates)) g.gate.dispose();
    }
  });
});
