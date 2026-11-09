import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, DefaultErrorPolicy, EmptyCompileError } from '../src/index.js';
import { withAudience } from '../src/dendrite/audience.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

// A message the context can't hold at a 12,000-token budget.
const LONG = `zz-long ${'lorem ipsum dolor sit amet '.repeat(2200)}`;

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String(event.content);
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text }] }],
      requestInference: !(event.metadata as { quiet?: boolean } | undefined)?.quiet,
    };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const emptyRequestRefusal = () => new MembraneError({
  type: 'invalid_request', retryable: false, httpStatus: 400, providerErrorCode: 'invalid_request_error',
  message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
  rawError: undefined,
} as never);

/** Answers as Anthropic does: an empty message list is a 400 invalid_request
 *  (membrane 0.9.0's MembraneError for it), anything else gets text. */
class ProviderLikeMembrane extends MockMembrane {
  readonly sent: NormalizedRequest[] = [];
  /** Answers for the direct API's next requests, before its default text. */
  readonly scripted: NormalizedResponse[] = [];
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.sent.push(request);
    if (request.messages.length === 0) return new ErrorStream(emptyRequestRefusal());
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.sent.length}` }])]);
  }
  override async stream(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.sent.push(request);
    if (request.messages.length === 0) throw emptyRequestRefusal();
    return this.scripted.shift() ?? createMockResponse([{ type: 'text', text: `zz-answer-${this.sent.length}` }]);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, boundMs = 10_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(5);
  }
}

type Trace = { type: string; kind?: string; message?: string; errorType?: string; agentName?: string };

async function harness(contextBudgetTokens: number, names: readonly string[] = ['resident'], extraModules: readonly Module[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'af-empty-compile-'));
  const membrane = new ProviderLikeMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: names.map((name) => ({ name, model: 'zz-model', systemPrompt: 'system', contextBudgetTokens })),
    modules: [new InputModule(), ...extraModules], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  } as never);
  const traces: Trace[] = [];
  framework.onTrace((e) => { traces.push(e as unknown as Trace); });
  const stderr: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
  framework.start();
  const count = (type: string) => traces.filter((t) => t.type === type).length;
  const settled = () => count('inference:completed') + count('inference:exhausted');
  const rows = () => framework.getAgent('resident')!.getContextManager().getAllMessages()
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));
  const say = (text: string, quiet = false) =>
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: quiet ? { quiet: true } : {} } as never);
  const wake = (extra: Record<string, unknown> = {}) => (framework as unknown as { pendingRequests: unknown[] }).pendingRequests
    .push({ agentName: 'resident', source: 'test', reason: 'zz-wake', timestamp: Date.now(), ...extra });
  const close = async () => {
    await framework.stop().catch(() => {});
    console.error = error;
    rmSync(dir, { recursive: true, force: true });
  };
  return { framework, membrane, traces, stderr, count, settled, rows, say, wake, close };
}

test('a newest message the budget can\'t hold ends its turn with no request, and the next wake sends the failure notice', async () => {
  const h = await harness(12_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first answer');
    const sentBefore = h.membrane.sent.length;
    h.say(LONG);
    await until(() => h.settled() === 2, 'the long message\'s turn');
    await sleep(50);
    assert.equal(h.membrane.sent.length, sentBefore, 'nothing is sent for the turn whose compile selected nothing');
    assert.equal(h.count('inference:failed'), 1, 'the turn is not retried');
    const exhausted = h.traces.filter((t) => t.type === 'inference:exhausted');
    assert.equal(exhausted.at(-1)!.errorType, 'empty_compile');
    const notice = h.rows().at(-1)!;
    assert.match(notice, /^\[inference-failed\]/);
    assert.equal(notice, "[inference-failed] Your previous turn wasn't sent: none of your conversation fit in your context. " +
      'If the newest message in your conversation is too large for your context, it and everything before it stay out of what you see until an operator raises your budget, ' +
      'and you can ask for it in smaller parts.', 'its own frame, the reason alone, no figures and no general advice');
    const alert = h.traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-refusal').at(-1)!;
    assert.ok(alert.message!.includes('the 7904 tokens a 12000-token budget leaves after 4096 reserved for the reply'), alert.message);
    assert.ok(alert.message!.includes('until the budget can hold it: raise contextBudgetTokens'), alert.message);

    h.wake();
    await until(() => h.settled() === 3, 'the wake after the failure');
    const next = h.membrane.sent.at(-1)!;
    const texts = next.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
    assert.ok(texts.some((t) => t.startsWith('[inference-failed]')), 'the failure notice is what the next request holds');
    assert.ok(!texts.some((t) => t.startsWith('zz-long')), 'the long message is still left out');
    assert.equal(h.count('inference:completed'), 2);
  } finally { await h.close(); }
});

test('a budget that leaves no room for any message fails every wake with that reason, sends nothing and sheds nothing', async () => {
  const h = await harness(4_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first turn');
    for (let i = 2; i <= 5; i++) {
      h.wake();
      await until(() => h.settled() === i, `wake ${i}`);
    }
    await sleep(100);
    assert.equal(h.membrane.sent.length, 0, 'no request is sent');
    assert.equal(h.count('inference:completed'), 0);
    assert.ok(h.traces.filter((t) => t.type === 'inference:exhausted').every((t) => t.errorType === 'empty_compile'));
    assert.ok(h.rows().includes('zz-q1'), 'the message said to it is kept');
    assert.ok(!h.stderr.some((l) => l.startsWith('[inference-rewind]')), 'the breaker sheds nothing');
    assert.ok(!h.rows().some((r) => r.startsWith('[refusal-rewind]')), 'no rewind notice is written');
    assert.equal(h.rows().filter((r) => r.startsWith('[inference-failed]')).length, 1, 'the streak leaves one failure notice, not one a wake');
    assert.ok(h.stderr.some((l) => l.startsWith('[inference-hard-down]')), 'from the third failure the agent is reported hard-down');
    const alerts = h.traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-refusal');
    assert.ok(alerts.length >= 1, 'the operator is alerted at once');
    assert.ok(alerts[0]!.message!.includes('contextBudgetTokens (4000) leaves no room once 4096 tokens are reserved for the reply: raise contextBudgetTokens'), alerts[0]!.message);
    const notice = h.rows().find((r) => r.startsWith('[inference-failed]'))!;
    assert.equal(notice, "[inference-failed] Your previous turn wasn't sent: the context budget leaves no room for any of your conversation once the reply's share is set aside, and only an operator can raise the budget.");
  } finally { await h.close(); }
});

test('a wake with nothing stored isn\'t refused: its request goes to membrane as before', async () => {
  const h = await harness(12_000);
  try {
    h.wake();
    await until(() => h.settled() === 1, 'the wake');
    assert.equal(h.membrane.sent.length, 1);
    assert.equal(h.membrane.sent[0]!.messages.length, 0);
  } finally { await h.close(); }
});

test('a resident whose shared slot holds only another resident\'s rows is sent as an agent with an empty store is: its window holds nothing', async () => {
  const h = await harness(12_000, ['resident', 'other']);
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-for-resident' }], withAudience(undefined, ['resident']))]);
    h.wake({ agentName: 'other' });
    await until(() => h.settled() === 1, 'the other resident\'s wake');
    assert.equal(h.membrane.sent.length, 1, 'it is sent');
    assert.equal(h.membrane.sent[0]!.messages.length, 0, 'holding none of the resident\'s rows');
    assert.ok(h.rows().includes('zz-for-resident'), 'the resident\'s row is kept');
  } finally { await h.close(); }
});

/** A module that gathers one afterUser injection each compile, placed by the compile or stored as a row. */
class Lessons implements Module {
  readonly name = 'lessons';
  lesson = 'zz-lesson';
  constructor(private readonly placed: boolean) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz' }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
  async gatherContext() {
    return [{ namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: this.lesson }], ...(this.placed ? { placedEachCompile: true } : {}) }] as never;
  }
}

for (const placed of [true, false]) {
  test(`a compile that selects only an injection ${placed ? 'the compile places' : 'stored as a row'}, beside a newest message it can't hold, ends with no request`, async () => {
    const lessons = new Lessons(placed);
    const h = await harness(12_000, ['resident'], [lessons]);
    try {
      h.say('zz-q1');
      await until(() => h.settled() === 1, 'the first answer');
      // A changed lesson is stored again at the next turn's start, after the long message, so it's the newest row.
      lessons.lesson = 'zz-lesson-2';
      const sentBefore = h.membrane.sent.length;
      h.say(LONG);
      await until(() => h.settled() === 2, 'the long message\'s turn');
      await sleep(50);
      assert.equal(h.membrane.sent.length, sentBefore, 'nothing is sent: the injection isn\'t the conversation');
      assert.equal(h.traces.filter((t) => t.type === 'inference:exhausted').at(-1)!.errorType, 'empty_compile');
    } finally { await h.close(); }
  });
}

const tick = (n: number) => ({ reason: 'heartbeat', source: 'heartbeat', suppressProse: true, silentHeartbeat: { eventId: `zz-tick-${n}`, serverId: 'heartbeat' } });

test('silent heartbeat ticks whose compile selects nothing end with no request, though a separator would have filled one, and a streak leaves one failure notice', async () => {
  const h = await harness(4_000);
  try {
    h.say('zz-q1', true);
    await until(() => h.rows().includes('zz-q1'), 'the row stored');
    for (let i = 1; i <= 4; i++) {
      h.wake(tick(i));
      await until(() => h.settled() === i, `tick ${i}`);
    }
    await sleep(50);
    assert.equal(h.membrane.sent.length, 0, 'no tick sends anything');
    assert.ok(h.traces.filter((t) => t.type === 'inference:exhausted').every((t) => t.errorType === 'empty_compile'));
    assert.equal(h.rows().filter((r) => r.startsWith('[inference-failed]')).length, 1, 'the streak leaves one failure notice');

    h.say('zz-q2', true);
    await until(() => h.rows().includes('zz-q2'), 'a new row stored');
    h.wake(tick(5));
    await until(() => h.settled() === 5, 'tick 5');
    await sleep(50);
    assert.equal(h.rows().filter((r) => r.startsWith('[inference-failed]')).length, 2, 'a failure after a new row writes its own notice');
  } finally { await h.close(); }
});

test('a tick refused because the newest message can\'t fit leaves a failure notice, which the next tick sends', async () => {
  const h = await harness(12_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first answer');
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    const sentBefore = h.membrane.sent.length;
    h.wake(tick(1));
    await until(() => h.settled() === 2, 'tick 1');
    await sleep(50);
    assert.equal(h.membrane.sent.length, sentBefore, 'tick 1 sends nothing');
    h.wake(tick(2));
    await until(() => h.settled() === 3, 'tick 2');
    const texts = h.membrane.sent.at(-1)!.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
    assert.ok(texts.some((t) => t.startsWith('[inference-failed]')), 'tick 2 sends the notice');
    assert.equal(h.count('inference:completed'), 2);
  } finally { await h.close(); }
});

for (const [form, metadata, content, named] of [
  ['its author and channel', { author: { name: 'Alice' }, serverId: 'discord', channelId: 'general' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is from Alice in discord:general. If that message'],
  ['its author alone', { authorName: 'Alice' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is from Alice. If that message'],
  ['its channel alone', { channelId: 'general' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is in general. If that message'],
  ['a tool result', { author: { name: 'Alice' } }, [{ type: 'tool_result', toolUseId: 'zz-t', content: [{ type: 'text', text: 'zz-out '.repeat(50) }] }], 'none of your conversation fit in your context. The newest message in your conversation is a tool result. If that message is too large for your context, it and everything before it stay out of what you see until an operator raises your budget, and you can call for less of it.'],
  ['nothing its metadata names', {}, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'none of your conversation fit in your context. If the newest message in your conversation'],
] as const) {
  test(`the notice names the newest row by ${form}, from its metadata alone`, async () => {
    // 4 tokens left for the window: a row of fifty words can't fit.
    const h = await harness(4_100);
    try {
      const cm = h.framework.getAgent('resident')!.getContextManager();
      cm.presentRows([cm.addMessage('user', content as never, metadata as never)]);
      h.wake();
      await until(() => h.settled() === 1, 'the wake');
      await sleep(50);
      assert.equal(h.membrane.sent.length, 0);
      const notice = h.rows().find((r) => r.startsWith('[inference-failed]'))!;
      assert.ok(notice.includes(named), notice);
      assert.ok(!notice.includes('zz-hi') && !notice.includes('zz-out'), 'none of the row\'s content');
    } finally { await h.close(); }
  });
}

test('the direct API refuses a compile that selects nothing, though tool results would be appended to it', async () => {
  const h = await harness(12_000);
  try {
    const agent = h.framework.getAgent('resident')!;
    const cm = agent.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: `zz-read ${'the whole file, please. '.repeat(10)}` }])]);
    h.membrane.scripted.push(createMockResponse([{ type: 'tool_use', id: 'zz-t1', name: 'zz_tool', input: {} }], 'tool_use'));
    const first = await agent.runInference(h.framework.getAllTools());
    assert.equal(first.toolCalls.length, 1);
    agent.provideToolResult('zz-t1', { success: true, data: 'zz-result' });
    h.framework.updateAgentRuntimeSettings('resident', { contextBudgetTokens: 4_100, immediate: true }, { allowInfeasible: true });
    const sentBefore = h.membrane.sent.length;
    await assert.rejects(agent.runInference(h.framework.getAllTools()), (err: unknown) => {
      assert.ok(err instanceof EmptyCompileError, String(err));
      assert.match((err as Error).message, /^none of your conversation fit in your context/);
      assert.match((err as EmptyCompileError).operatorNote, /the 4 tokens a 4100-token budget leaves after 4096 reserved for the reply/);
      return true;
    });
    assert.equal(h.membrane.sent.length, sentBefore, 'its results go nowhere without their call');
  } finally { await h.close(); }
});

test('the direct API rejects a compile that selects nothing before it sends', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    const agent = h.framework.getAgent('resident')!;
    await assert.rejects(agent.runInference(h.framework.getAllTools()), (err: unknown) => {
      assert.ok(err instanceof EmptyCompileError, String(err));
      assert.equal((err as EmptyCompileError).retryable, false);
      assert.match((err as Error).message, /^none of your conversation fit in your context/);
      return true;
    });
    assert.equal(h.membrane.sent.length, 0);
  } finally { await h.close(); }
});

test('a preview of a compile that selects nothing doesn\'t throw', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    const preview = await h.framework.previewActivation('resident');
    assert.equal(preview.messages.length, 0);
  } finally { await h.close(); }
});

test('the default error policy doesn\'t retry an empty compile', () => {
  const policy = new DefaultErrorPolicy();
  assert.deepEqual(policy.onInferenceError(new EmptyCompileError(12_000, 4_096), 'resident', 0), { retry: false });
});
