/**
 * Probe P1, for agent-framework #793's "the persistent subconscious probably
 * has the same gap": the persistent subconscious (not reader forks) reading a
 * tune-out while the resident's turn runs. Two ambient messages, then an
 * addressed one, arrive (a) with the resident idle, (b) mid-turn, where they
 * wait in the deferred queue. Which of the three the subconscious's request
 * at the wake holds, where they stand then, and what its next look holds.
 *
 * Logs PROBE-P1 lines; asserts only that the setup ran.
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
    const body = JSON.stringify(request.messages);
    const who = body.includes('[Tune-out wake') || body.includes('[Tune-out cadence') ? 'reader' : 'resident';
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
  const tag = `P1${mode === 'idle' ? 'a' : 'b'}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'probe-793-p1-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new RoutedMembrane();
  const module = new WaitModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, reader: 'persistent', model: 'test-model', systemPrompt: 'Read for scout.' },
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
    membrane.push('reader', createMockResponse([{ type: 'text', text: 'zz-p1-read' }]));
    appendFileSync(commandPath, `addressed ${tag}c ${tag}-ADDR-3 hey scout\n`);
    const readerCalls = () => membrane.calls.filter((c) => { const b = JSON.stringify(c.messages); return b.includes('[Tune-out wake') || b.includes('[Tune-out cadence'); });
    const tags = [`${tag}-AMB-1`, `${tag}-AMB-2`, `${tag}-ADDR-3`, `${tag}-ADDR-4`];
    const describe = (c: NormalizedRequest, n: number) => {
      const b = JSON.stringify(c.messages);
      const notices = (b.match(/\[Tune-out (wake|cadence)[^\]]*\]/g) ?? []);
      return `#${n + 1}: holds ${tags.filter((t) => b.includes(t)).map((t) => t.slice(tag.length + 1)).join('+') || 'none'}; last notice ${JSON.stringify(notices.at(-1) ?? null)}`;
    };
    const asked = await waitFor("the subconscious's request at the wake", () => readerCalls().length >= 1, 30_000).then(() => true, () => false);
    console.log(`# PROBE-${tag} the subconscious was asked at the wake: ${asked}`);
    if (!asked) return;
    const where = (s: string) => storedHas(s) ? 'stored' : deferredHas(s) ? 'queued' : 'neither';
    console.log(`# PROBE-${tag} at its first request: AMB-1 ${where(`${tag}-AMB-1`)}, AMB-2 ${where(`${tag}-AMB-2`)}, ADDR-3 ${where(`${tag}-ADDR-3`)}`);
    // Let the subconscious's own turn settle before the resident's ends.
    await new Promise((r) => setTimeout(r, 3_000));
    const beforeRelease = readerCalls().length;
    console.log(`# PROBE-${tag} its requests before the resident's turn ends: ${readerCalls().slice(0, beforeRelease).map(describe).join(' | ')}`);
    release();
    await new Promise((r) => setTimeout(r, 4_000));
    const afterRelease = readerCalls().length;
    console.log(`# PROBE-${tag} after the resident's turn: AMB-1 ${where(`${tag}-AMB-1`)}, AMB-2 ${where(`${tag}-AMB-2`)}, ADDR-3 ${where(`${tag}-ADDR-3`)}; requests made as it ended: ${readerCalls().slice(beforeRelease).map((c, k) => describe(c, beforeRelease + k)).join(' | ') || 'none'}`);
    // The next look: one more addressed message wakes the subconscious again.
    membrane.push('reader', createMockResponse([{ type: 'text', text: 'zz-p1-read-2' }]));
    appendFileSync(commandPath, `addressed ${tag}d ${tag}-ADDR-4 scout again\n`);
    const again = await waitFor("the subconscious's next request", () => readerCalls().length > afterRelease, 30_000).then(() => true, () => false);
    await new Promise((r) => setTimeout(r, 2_000));
    console.log(`# PROBE-${tag} after a second addressed message: ${again ? readerCalls().slice(afterRelease).map((c, k) => describe(c, afterRelease + k)).join(' | ') : 'no request within 30 s'}`);
  } finally {
    release();
    console.error = orig;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('persistent subconscious probe P1', () => {
  it('PROBE P1a: the persistent subconscious at a wake, resident idle', { timeout: 150_000 }, async () => { await run('idle'); });
  it('PROBE P1b: the persistent subconscious at a wake, three held mid-turn', { timeout: 150_000 }, async () => { await run('mid-turn'); });
});
