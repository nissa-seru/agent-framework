/**
 * Probe R20 for a finding a review of #546's catch-up merge raised in
 * Dendrite's reader-fork code, which the merge doesn't change: with reader
 * forks at backlogCap 1, a reader fork cancels its own tune-out with
 * cancel_tuneout. (a) with the resident idle, two ambient messages stored
 * before an addressed one derives the fork; (b) with the resident mid-turn,
 * two ambient messages held, then the addressed one. What the cancelling
 * fork was handed, what the dump shows, and whether any later fork reads
 * what the cancelling fork didn't see.
 *
 * Logs PROBE-R20 lines; asserts only that the setup ran.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult, TraceEvent } from '../../src/index.js';
import { AgentFramework, defaultReaderFraming } from '../../src/index.js';
import { MockYieldingStream, createMockResponse } from '../helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

class WaitModule implements Module {
  readonly name = 'probe';
  hold: Promise<void> = Promise.resolve();
  onWait: () => void = () => {};
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the probe', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    this.onWait();
    await this.hold;
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: { type: string; source?: string }): Promise<EventResponse> {
    if (event.type !== 'external-message' || event.source !== 'probe') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
  }
}

class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  streams: Array<{ who: string; stream: MockYieldingStream }> = [];
  private queues = { resident: [] as NormalizedResponse[], reader: [] as NormalizedResponse[] };
  push(who: 'resident' | 'reader', ...responses: NormalizedResponse[]): void { this.queues[who].push(...responses); }
  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const who = JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'resident';
    // As test/helpers/reader-fork-rig.ts: one stream takes every response queued for its role,
    // so a tool round and its continuation go in together.
    const responses = this.queues[who].splice(0);
    if (responses.length === 0) responses.push(createMockResponse([{ type: 'text', text: `${who}-default` }]));
    const stream = new MockYieldingStream(responses);
    this.streams.push({ who, stream });
    return stream;
  }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}


type Mode = 'idle' | 'mid-turn';
async function run(mode: Mode): Promise<void> {
  const tag = `R20${mode === 'idle' ? 'a' : 'b'}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'probe-546-r20-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new RoutedMembrane();
  const module = new WaitModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.', framing: (ctx) => defaultReaderFraming(ctx) },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
    modules: [module],
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  const orig = console.error;
  console.error = () => {};
  let release: () => void = () => {};
  try {
    await framework.start();
    const i = framework as unknown as {
      tuneOutCoordinator: TuneOutCoordinator;
      deferredMessages: Array<{ content: ContentBlock[] }>;
      channelRegistry: { listChannelsRaw(): unknown[] };
    };
    await waitFor('channel registration', () => i.channelRegistry.listChannelsRaw().length > 0);
    assert.ok(i.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 1, maxWakes: 5 }, 'agent-tool').ok);
    const scout = () => framework.getAgent('scout')!.getContextManager();
    const storedHas = (s: string) => (scout().getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }> }>).some((m) => textOf(m).includes(s));
    const deferredHas = (s: string) => i.deferredMessages.some((m) => textOf(m as never).includes(s));

    if (mode === 'mid-turn') {
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.push('resident',
        createMockResponse([{ type: 'text', text: 'Waiting.' }, { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} }] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'Done.' }]),
      );
      framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
      await inTool;
    }
    const seen = mode === 'idle' ? storedHas : deferredHas;
    appendFileSync(commandPath, `ambient ${tag}a ${tag}-AMB-1 first chatter\n`);
    await waitFor('the first ambient', () => seen(`${tag}-AMB-1`));
    appendFileSync(commandPath, `ambient ${tag}b ${tag}-AMB-2 second chatter\n`);
    await waitFor('the second ambient', () => seen(`${tag}-AMB-2`));

    membrane.push('reader',
      createMockResponse([{ type: 'tool_use', id: 'call-cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } }] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'zz-r20-after-cancel' }]),
    );
    appendFileSync(commandPath, `addressed ${tag}c ${tag}-ADDR-3 hey scout\n`);
    const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { agentName: string; trigger: string; held: number }>;
    const derived = await waitFor('a reader fork', () => forkTraces().length >= 1, 30_000).then(() => true, () => false);
    console.log(`# PROBE-${tag} a fork was derived for the addressed message: ${derived} [${forkTraces().map((t) => `${t.trigger}:held=${t.held}`).join(', ')}]`);
    if (!derived) return;
    const fork = forkTraces()[0]!;
    const cancelled = await waitFor('the cancel', () => traces.some((t) => (t as { type: string }).type === 'tune-out:cancelled'), 30_000).then(() => true, () => false);
    const cancelTrace = traces.find((t) => (t as { type: string }).type === 'tune-out:cancelled') as (TraceEvent & { reason?: string }) | undefined;
    const framing = ((await framework.inspectAgentContext(fork.agentName)).getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: { kind?: string } }>)
      .find((m) => m.metadata?.kind === 'tune-out-reader-framing');
    const ft = framing ? textOf(framing) : '';
    console.log(`# PROBE-${tag} the fork's own cancel went through: ${cancelled} (reason ${JSON.stringify(cancelTrace?.reason ?? null)}); its framing names AMB-1: ${ft.includes(`${tag}-AMB-1`)}, AMB-2: ${ft.includes(`${tag}-AMB-2`)}, ADDR-3: ${ft.includes(`${tag}-ADDR-3`)}`);
    const readerStream = membrane.streams.find((x) => x.who === 'reader')?.stream;
    console.log(`# PROBE-${tag} the cancel's tool result: ${JSON.stringify(readerStream?.receivedToolResults ?? null).slice(0, 400)}`);
    release();
    await new Promise((r) => setTimeout(r, 4_000));
    const dumps = (scout().getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }> }>).map((m) => textOf(m)).filter((t) => t.includes('<tuned-out-backlog'));
    console.log(`# PROBE-${tag} dumps in scout's store: ${JSON.stringify(dumps.map((d) => d.replace(/\n/g, ' | ')))}`);
    const compiled = await scout().compile();
    const inCompiledRow = (s: string) => compiled.messages.some((m) => textOf(m as never).includes(s));
    console.log(`# PROBE-${tag} in scout's compiled view: AMB-1 ${inCompiledRow(`${tag}-AMB-1`)}, AMB-2 ${inCompiledRow(`${tag}-AMB-2`)}, ADDR-3 ${inCompiledRow(`${tag}-ADDR-3`)}`);
    console.log(`# PROBE-${tag} forks after the cancelling one: [${forkTraces().slice(1).map((t) => `${t.trigger}:held=${t.held}`).join(', ')}]`);
  } finally {
    release();
    console.error = orig;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('reader-fork probe R20', () => {
  it('PROBE R20a: a reader fork cancels its own tune-out, resident idle', { timeout: 120_000 }, async () => { await run('idle'); });
  it('PROBE R20b: a reader fork cancels its own tune-out, two held mid-turn', { timeout: 120_000 }, async () => { await run('mid-turn'); });
});
