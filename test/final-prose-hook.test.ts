import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, InferenceRequest, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const ROOM = 'discord:g1:room';
const ROOM_SHOWN = '#room (Guild One) (discord:g1:room)';
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input }) as ContentBlock;
const said = (...blocks: ContentBlock[]) => createMockResponse(blocks, blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
const skip = (id = 'k1') => call(id, 'skip_reply', { reason: 'nothing more' });

type Part = { kind: string; text?: string; where?: string; delivered?: boolean };
interface Report { agent: string; parts: Part[]; receiptsBefore: number }

class Probe implements Module {
  readonly name: string;
  reports: Report[] = [];
  published: () => string[] = () => [];
  receipts: () => number = () => 0;
  publishedAtReport: string[][] = [];
  statusesAtReport: string[][] = [];
  statuses: () => string[] = () => [];
  behaviour: 'records' | 'throws' | 'rejects' | 'hangs' | 'mutates' = 'records';
  gate: Promise<void> | undefined;
  entered = false;
  constructor(name = 'probe') { this.name = name; }
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return this.name === 'probe' ? [{ name: 'look', description: 'Look around.', inputSchema: { type: 'object', properties: {} } }] : [];
  }
  async onProcess(): Promise<EventResponse> {
    return {};
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.entered = true;
    if (this.gate) await this.gate;
    return { success: true, data: 'seen' };
  }
  onFinalProse(agentName: string, parts: Part[]): void | Promise<void> {
    this.reports.push({ agent: agentName, parts: parts.map((part) => ({ ...part })), receiptsBefore: this.receipts() });
    this.publishedAtReport.push(this.published());
    this.statusesAtReport.push(this.statuses());
    if (this.behaviour === 'mutates') {
      for (const part of parts) part.kind = 'changed';
      parts.length = 0;
      return;
    }
    if (this.behaviour === 'throws') throw new Error('the probe broke');
    if (this.behaviour === 'rejects') return Promise.reject(new Error('the probe rejected'));
    if (this.behaviour === 'hangs') return new Promise<void>(() => {});
  }
}

class Failing extends MockYieldingStream {
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
    throw new Error('provider unavailable');
  }
}

/** Membrane's XML tool path: tool-calls events carry each round's own text and no verbatim round content, and the turn-end response is the whole turn's parse. */
class XmlStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private done = false;
  private waiting = false;
  private round = 0;
  private pending: (() => void) | null = null;
  private readonly whole: ContentBlock[] = [];
  constructor(private readonly rounds: NormalizedResponse[]) {
    this.emit();
  }
  private emit(): void {
    const response = this.rounds[this.round]!;
    const words = response.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    this.whole.push(...response.content);
    if (response.toolCalls.length === 0) {
      this.events.push({ type: 'complete', response: { ...response, content: [...this.whole] } } as StreamEvent);
      this.done = true;
    } else {
      this.waiting = true;
      this.events.push({
        type: 'tool-calls',
        calls: response.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input as Record<string, unknown> })),
        context: { rawText: '', preamble: words, roundPreamble: words, depth: this.round, previousResults: [], accumulated: words, supportsInjectedMessages: false },
      } as StreamEvent);
    }
    this.wake();
  }
  provideToolResults(): void {
    if (!this.waiting) throw new Error('Not waiting for tools');
    this.waiting = false;
    this.round++;
    this.emit();
  }
  cancel(): void {
    this.done = true;
    this.events.push({ type: 'aborted', reason: 'user' } as StreamEvent);
    this.wake();
  }
  private wake(): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve();
    }
  }
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds(): string[] { return this.waiting ? this.rounds[this.round]!.toolCalls.map((c) => c.id) : []; }
  get toolDepth() { return this.round; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') return;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.pending = resolve; });
    }
  }
}

type Mode = 'locus' | 'hybrid' | 'explicit' | 'disabled';
interface Run {
  reports: Report[];
  publishedAtReport: string[][];
  statusesAtReport: string[][];
  statuses: string[];
  publishes: string[];
  events: string[];
  receipts: number;
  second?: Report[];
}

async function run(options: {
  proseRouting: Mode;
  turns: NormalizedResponse[][];
  registry?: boolean;
  start?: 'incoming' | 'wake' | 'silent' | 'heartbeat';
  first?: { fails?: boolean; stop?: boolean };
  xml?: boolean;
  behaviour?: Probe['behaviour'];
  second?: Probe['behaviour'];
  commands?: Array<Record<string, unknown>>;
  requestTimeoutMs?: number;
  followUp?: boolean;
  reports?: number;
}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'af-final-prose-'));
  const commandPath = join(dir, 'commands.jsonl');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  const lines = () => existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; text?: string })
    : [];
  const published = () => lines().filter((l) => l.event === 'publish').map((l) => l.text ?? '');
  const probe = new Probe();
  probe.behaviour = options.behaviour ?? 'records';
  probe.published = published;
  probe.statuses = () => lines().map((l) => l.event);
  const other = options.second ? new Probe('other') : undefined;
  if (other) other.behaviour = options.second!;
  let release: () => void = () => {};
  if (options.first?.stop) probe.gate = new Promise((resolve) => { release = resolve; });
  const membrane = new MockMembrane();
  let streams = 0;
  membrane.streamYielding = () => {
    const turn = streams;
    streams += 1;
    const rounds = options.turns[turn] ?? [said(skip(`k-${turn}`))];
    if (options.xml) return new XmlStream(rounds);
    return turn === 0 && options.first?.fails ? new Failing(rounds) : new MockYieldingStream(rounds);
  };
  const registry = options.registry !== false;
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: options.proseRouting }],
    ...(registry ? {
      mcplServers: [{
        id: 'discord', command: process.execPath, args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath, SEND_TOOL: '1' }, toolPrefix: 'discord',
        ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      }],
    } : {}),
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    modules: other ? [probe, other] : [probe],
  } as Parameters<typeof AgentFramework.create>[0]);
  const internals = framework as unknown as {
    channelRegistry?: { listChannelsRaw(): unknown[] };
    activeTurnTokens: Map<string, unknown>;
    pendingRequests: InferenceRequest[];
  };
  const contextTexts = () => framework.getAgent('scout')!.getContextManager().getAllMessages()
    .map((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join(''));
  probe.receipts = () => contextTexts().filter((t) => t.startsWith('[delivered]')).length;
  const events: string[] = [];
  framework.onTrace((event) => {
    if (event.type === 'inference:failed' || event.type === 'inference:aborted') events.push(event.type);
  });
  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const wake = (start: 'wake' | 'silent' | 'heartbeat') => internals.pendingRequests.push({
    agentName: 'scout', reason: start, source: start === 'wake' ? 'test' : 'heartbeat', timestamp: Date.now(),
    ...(start === 'silent' ? { suppressProse: true, silentHeartbeat: { eventId: 'tick-1', serverId: 'heartbeat' } } : {}),
  } as InferenceRequest);
  try {
    await framework.start();
    const start = options.start ?? (registry ? 'incoming' : 'wake');
    if (registry) await until(() => (internals.channelRegistry?.listChannelsRaw().length ?? 0) >= 2, 'the channels');
    for (const command of options.commands ?? []) appendFileSync(commandPath, JSON.stringify(command) + '\n');
    if (start === 'incoming') {
      appendFileSync(commandPath, JSON.stringify({ op: 'incoming', channelId: ROOM, messageId: 'in-1', mode: 'addressed', text: 'hello scout' }) + '\n');
    } else {
      wake(start);
    }
    if (options.first?.stop) {
      await until(() => probe.entered, 'the held tool call');
      framework.abortInference('scout', 'stopped by the test');
      release();
    }
    if (options.followUp) {
      await until(() => streams >= 1 && !internals.activeTurnTokens.has('scout') && internals.pendingRequests.length === 0, 'the first turn to end');
      await framework.runUntilIdle();
      wake('wake');
    }
    await until(() => probe.reports.length >= (options.reports ?? 1), `${options.reports ?? 1} report(s)`);
    await until(() => !internals.activeTurnTokens.has('scout') && internals.pendingRequests.length === 0, 'the turns to end');
    await framework.runUntilIdle();
    return {
      reports: probe.reports,
      publishedAtReport: probe.publishedAtReport,
      statusesAtReport: probe.statusesAtReport,
      statuses: probe.statuses(),
      publishes: published(),
      events,
      receipts: probe.receipts(),
      ...(other ? { second: other.reports } : {}),
    };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const parts = (r: Run) => r.reports.map((report) => report.parts);

describe('Module.onFinalProse: how a turn\'s closing words ended, once per turn, after its final routing', () => {
  it('locus: a text-only reply routed to the turn\'s channel is reported routed, with its words, naming the agent, before its receipt', async () => {
    const r = await run({ proseRouting: 'locus', turns: [[said(text('Hello there.'))]] });
    assert.deepEqual(r.publishes, ['Hello there.'], 'premise: it was posted');
    assert.deepEqual(r.reports, [{ agent: 'scout', parts: [{ kind: 'routed', text: 'Hello there.' }], receiptsBefore: 0 }]);
    assert.equal(r.receipts, 1, 'the receipt came after the report');
  });

  it('locus: a reply whose post wasn\'t delivered is still reported routed, with its words', async () => {
    const r = await run({ proseRouting: 'locus', commands: [{ op: 'publish-mode', mode: 'not-delivered' }], turns: [[said(text('Hello there.'))]] });
    assert.ok(r.statuses.includes('publish-refused'), 'premise: the server refused the post');
    assert.deepEqual(parts(r)[0], [{ kind: 'routed', text: 'Hello there.' }]);
  });

  it('locus: a turn from no channel, with a registry, reports its reply routed, with its words, though nothing was posted', async () => {
    const r = await run({ proseRouting: 'locus', start: 'wake', turns: [[said(text('Hello there.'))]] });
    assert.deepEqual(r.publishes, [], 'premise: no locus, so nothing was posted');
    assert.deepEqual(parts(r)[0], [{ kind: 'routed', text: 'Hello there.' }]);
  });

  it('locus: a tool turn\'s closing words are reported, not its earlier rounds\'', async () => {
    const r = await run({ proseRouting: 'locus', turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'Found it.' }]]);
  });

  it('is reported once the closing words were published', async () => {
    const r = await run({ proseRouting: 'locus', turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(r.publishedAtReport, [['Looking.', 'Found it.']]);
  });

  it('locus: closing words held after a send to the turn\'s channel are reported sent, with where and that it delivered, and no words', async () => {
    const r = await run({
      proseRouting: 'locus',
      turns: [[said(text('Posting it now.'), call('s1', 'discord--send_message', { channelId: ROOM, text: 'The report is up.' })), said(text('Done — I sent it to the room.'))]],
    });
    assert.ok(r.statuses.includes('send'), 'premise: the send reached the server');
    assert.ok(!r.publishes.includes('Done — I sent it to the room.'), 'premise: the closing words were held');
    assert.deepEqual(parts(r), [[{ kind: 'sent', where: ROOM_SHOWN, delivered: true }]]);
  });

  it('locus: closing words held after a publish that may have posted are reported sent, not delivered', async () => {
    const r = await run({
      proseRouting: 'locus',
      commands: [{ op: 'publish-mode', mode: 'no-receipt' }],
      turns: [[said(text('Posting it now.'), call('p1', 'channel_publish', { channelId: ROOM, content: 'The report is up.' })), said(text('Done, I think.'))]],
    });
    assert.ok(r.publishes.includes('The report is up.'), 'premise: the publish reached the server, which gave no receipt');
    assert.ok(!r.publishes.includes('Done, I think.'), 'premise: the closing words were held');
    assert.deepEqual(parts(r), [[{ kind: 'sent', where: ROOM_SHOWN, delivered: false }]]);
  });

  it('locus: closing words held after a send whose reach is unknown are reported sent-unknown', async () => {
    const r = await run({
      proseRouting: 'locus',
      commands: [{ op: 'send-mode', mode: 'no-channel' }],
      turns: [[said(text('Posting it now.'), call('s1', 'discord--send_message', { channelId: ROOM, text: 'The report is up.' })), said(text('Done, somewhere.'))]],
    });
    assert.ok(r.statuses.includes('send'), 'premise: the send reached the server');
    assert.ok(!r.publishes.includes('Done, somewhere.'), 'premise: the closing words were held');
    assert.deepEqual(parts(r), [[{ kind: 'sent-unknown' }]]);
  });

  it('locus: a turn skip_reply ends reports its last round\'s words private, with no words', async () => {
    const r = await run({ proseRouting: 'locus', turns: [[said(text('Not mine to answer.'), skip())]] });
    assert.deepEqual(parts(r), [[{ kind: 'private' }]]);
  });

  it('hybrid: a turn a tool ends is reported once its routing has run, behind an earlier post still pending', async () => {
    const r = await run({
      proseRouting: 'hybrid', requestTimeoutMs: 1_000, commands: [{ op: 'publish-mode', mode: 'hang' }],
      turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Not mine to answer.'), skip())]],
    });
    assert.ok(r.statusesAtReport[0]?.includes('publish-hung'), 'premise: the earlier post was taken and hung');
    assert.deepEqual(parts(r)[0], [{ kind: 'private' }]);
  });

  it('explicit: a turn a tool ends is reported once its deliveries have run, behind an earlier post still pending', async () => {
    const r = await run({
      proseRouting: 'explicit', requestTimeoutMs: 1_000, commands: [{ op: 'publish-mode', mode: 'hang' }],
      turns: [[said(text('>>#room Looking.'), call('l1', 'probe--look')), said(text('>>#room Not this time.'), skip())]],
    });
    assert.ok(r.statusesAtReport[0]?.includes('publish-hung'), 'premise: the earlier post was taken and hung');
    assert.deepEqual(parts(r)[0], [{ kind: 'private' }]);
  });

  it('locus: a heartbeat turn with no locus reports its words no-destination', async () => {
    const r = await run({ proseRouting: 'locus', start: 'heartbeat', turns: [[said(text('Nobody to tell.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'no-destination' }]]);
  });

  it('hybrid: a routed envelope and a >>>skip_reply one are two parts, in the order written', async () => {
    const r = await run({ proseRouting: 'hybrid', turns: [[said(text('Here is the answer.\n>>>skip_reply A note to myself.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'Here is the answer.' }, { kind: 'private' }]]);
  });

  it('hybrid: words addressed to the room are reported routed, with the words posted', async () => {
    const r = await run({ proseRouting: 'hybrid', turns: [[said(text('>>>#room Hello, room.'))]] });
    assert.deepEqual(r.publishes, ['Hello, room.'], 'premise: it was posted');
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'Hello, room.' }]]);
  });

  it('hybrid: words for a destination that doesn\'t resolve are reported no-destination', async () => {
    const r = await run({ proseRouting: 'hybrid', turns: [[said(text('>>>#nowhere Anyone there?'))]] });
    assert.deepEqual(parts(r)[0], [{ kind: 'no-destination' }]);
  });

  it('explicit: unprefixed words are reported no-destination, with no words', async () => {
    const r = await run({ proseRouting: 'explicit', turns: [[said(text('Hello, whoever.'))]] });
    assert.deepEqual(parts(r)[0], [{ kind: 'no-destination' }]);
  });

  it('explicit: words addressed to the room are reported routed, with the words posted', async () => {
    const r = await run({ proseRouting: 'explicit', turns: [[said(text('>>#room Hello, room.'))]] });
    assert.deepEqual(r.publishes, ['Hello, room.'], 'premise: it was posted');
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'Hello, room.' }]]);
  });

  it('explicit: words for a destination that doesn\'t resolve are reported no-destination', async () => {
    const r = await run({ proseRouting: 'explicit', turns: [[said(text('>>#nowhere Anyone there?'))]] });
    assert.deepEqual(parts(r)[0], [{ kind: 'no-destination' }]);
  });

  it('explicit: a turn skip_reply ends is reported, its words private', async () => {
    const r = await run({ proseRouting: 'explicit', turns: [[said(text('>>#room Not this time.'), skip())]] });
    assert.deepEqual(parts(r), [[{ kind: 'private' }]]);
  });

  it('disabled: the closing words are reported disabled, with their words', async () => {
    const r = await run({ proseRouting: 'disabled', turns: [[said(text('Quiet words.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'disabled', text: 'Quiet words.' }]]);
  });

  it('disabled: a tool turn\'s closing words are reported disabled, with their words', async () => {
    const r = await run({ proseRouting: 'disabled', turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'disabled', text: 'Found it.' }]]);
  });

  it('disabled: words of a round skip_reply ends are reported private, not disabled', async () => {
    const r = await run({ proseRouting: 'disabled', turns: [[said(text('Not mine to answer.'), skip())]] });
    assert.deepEqual(parts(r), [[{ kind: 'private' }]]);
  });

  it('disabled: words of a round cut off at the output limit stay disabled, since disabled routing decides no privacy there', async () => {
    const cut = { ...createMockResponse([text('A note to myself.'), call('k1', 'skip_reply', { reason: 'later' })], 'max_tokens'), toolCalls: [] };
    const r = await run({ proseRouting: 'disabled', turns: [[cut]] });
    assert.deepEqual(parts(r)[0], [{ kind: 'disabled', text: 'A note to myself.' }]);
  });

  it('without a channel registry a reply is reported no-registry, with its words', async () => {
    const r = await run({ proseRouting: 'locus', registry: false, turns: [[said(text('Hello there.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'no-registry', text: 'Hello there.' }]]);
  });

  it('without a channel registry a disabled agent\'s reply is reported no-registry, with its words', async () => {
    const r = await run({ proseRouting: 'disabled', registry: false, turns: [[said(text('Quiet words.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'no-registry', text: 'Quiet words.' }]]);
  });

  it('without a channel registry a tool turn reports only its closing words', async () => {
    const r = await run({ proseRouting: 'locus', registry: false, turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'no-registry', text: 'Found it.' }]]);
  });

  it('without a channel registry an explicit or hybrid agent\'s words are reported no-destination, whatever their envelopes', async () => {
    const explicit = await run({ proseRouting: 'explicit', registry: false, turns: [[said(text('>>skip_reply Mine alone.\n>>#room Hello.'))]] });
    assert.deepEqual(parts(explicit), [[{ kind: 'no-destination' }]]);
    const hybrid = await run({ proseRouting: 'hybrid', registry: false, turns: [[said(text('Hello.\n>>>skip_reply Mine alone.'))]] });
    assert.deepEqual(parts(hybrid), [[{ kind: 'no-destination' }]]);
  });

  it('a silent turn is reported silent, with no words', async () => {
    const r = await run({ proseRouting: 'locus', start: 'silent', turns: [[said(text('A private check.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'silent' }]]);
  });

  it('a silent turn without a channel registry is reported silent, not no-registry', async () => {
    const r = await run({ proseRouting: 'locus', registry: false, start: 'silent', turns: [[said(text('A private check.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'silent' }]]);
  });

  it('a silent tool turn reports its closing words only, silent', async () => {
    const r = await run({ proseRouting: 'locus', start: 'silent', turns: [[said(text('Checking.'), call('l1', 'probe--look')), said(text('All quiet.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'silent' }]]);
  });

  it('a silent turn a tool ends is reported silent', async () => {
    const r = await run({ proseRouting: 'locus', start: 'silent', turns: [[said(text('Nothing to do.'), skip())]] });
    assert.deepEqual(parts(r), [[{ kind: 'silent' }]]);
  });

  it('a closing round with no words is reported with no parts', async () => {
    const r = await run({ proseRouting: 'locus', turns: [[said(text('Looking.'), call('l1', 'probe--look')), createMockResponse([], 'end_turn')]] });
    assert.deepEqual(parts(r), [[]]);
  });

  it('XML tool path: without a registry a tool turn reports the whole turn\'s words, as that path routes them', async () => {
    const r = await run({ proseRouting: 'locus', registry: false, xml: true, turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(parts(r), [[{ kind: 'no-registry', text: 'Looking.' }, { kind: 'no-registry', text: 'Found it.' }]]);
  });

  it('XML tool path: a tool turn reports the whole turn\'s words as its final routing routed them, in order', async () => {
    const r = await run({ proseRouting: 'locus', xml: true, turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Found it.'))]] });
    assert.deepEqual(r.publishes, ['Looking.', 'Found it.'], 'premise: the XML path posted the whole turn at its end');
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'Looking.' }, { kind: 'routed', text: 'Found it.' }]]);
  });

  it('XML tool path: a turn a tool ends reports no parts, on a silent turn too', async () => {
    const r = await run({ proseRouting: 'locus', xml: true, turns: [[said(text('Not mine to answer.'), skip())]] });
    assert.deepEqual(parts(r), [[]]);
    const silent = await run({ proseRouting: 'locus', xml: true, start: 'silent', turns: [[said(text('Nothing to do.'), skip())]] });
    assert.deepEqual(parts(silent), [[]]);
  });

  it('is not called for a turn that fails', async () => {
    const r = await run({ proseRouting: 'locus', first: { fails: true }, followUp: true, turns: [[said(text('Looking.'), call('l1', 'probe--look'))], [said(text('After.'))]] });
    assert.ok(r.events.includes('inference:failed'), 'premise: the first turn failed');
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'After.' }]]);
  });

  it('is not called for a turn that is stopped', async () => {
    const r = await run({ proseRouting: 'locus', first: { stop: true }, followUp: true, turns: [[said(text('Looking.'), call('l1', 'probe--look')), said(text('Never said.'))], [said(text('After.'))]] });
    assert.ok(r.events.includes('inference:aborted'), 'premise: the first turn was stopped');
    assert.deepEqual(parts(r), [[{ kind: 'routed', text: 'After.' }]]);
  });

  for (const behaviour of ['throws', 'rejects', 'hangs'] as const) {
    it(`a module whose notice ${behaviour} changes nothing for the turn: its receipt still lands, and the next module is told`, async () => {
      const r = await run({ proseRouting: 'locus', behaviour, second: 'records', turns: [[said(text('Hello there.'))]] });
      assert.equal(r.reports.length, 1);
      assert.equal(r.receipts, 1, 'the receipt landed');
      assert.deepEqual(r.second?.map((report) => report.parts), [[{ kind: 'routed', text: 'Hello there.' }]]);
    });
  }

  it('each module gets the parts whole, whatever another module does with its own', async () => {
    const r = await run({ proseRouting: 'locus', behaviour: 'mutates', second: 'records', turns: [[said(text('Hello there.'))]] });
    assert.deepEqual(r.second?.map((report) => report.parts), [[{ kind: 'routed', text: 'Hello there.' }]]);
  });
});
