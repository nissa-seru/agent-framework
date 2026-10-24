/**
 * Probe R2 for a finding a review of #546's catch-up merge raised in
 * Dendrite's reader-fork code, which the merge doesn't change: with reader
 * forks, a tune-out cancelled while two tuned-out messages are still held
 * mid-turn, at backlogCap 1. What the resident's dump shows, what the
 * cancel's reader fork is handed, and whether the message the dump leaves
 * out reaches any reader or the resident's compiled view afterwards.
 *
 * Logs PROBE-R2 lines; asserts only that the setup ran.
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

describe('reader-fork probe R2', () => {
  it('PROBE R2: cancel with two held mid-turn, backlogCap 1, reader forks', { timeout: 150_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'probe-546-r2-'));
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

      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.push('resident',
        createMockResponse([{ type: 'text', text: 'Waiting.' }, { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} }] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'Done.' }]),
      );
      membrane.push('reader', createMockResponse([{ type: 'text', text: 'zz-cancel-fork-report' }]));
      framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
      await inTool;

      const held = () => i.deferredMessages.filter((m) => textOf(m as never).includes('R2-HELD'));
      appendFileSync(commandPath, 'ambient r2a R2-HELD-1 chatter while the turn is alive\n');
      await waitFor('the first held', () => held().length === 1);
      appendFileSync(commandPath, 'ambient r2b R2-HELD-2 more chatter while the turn is alive\n');
      await waitFor('the second held', () => held().length === 2);

      assert.ok(i.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'probe').ok);
      const dump = () => i.deferredMessages.map((m) => textOf(m as never)).find((t) => t.includes('<tuned-out-backlog'));
      await waitFor('the dump', () => dump() !== undefined);
      const forkTraces = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { agentName: string; trigger: string; held: number }>;
      await waitFor('the cancel fork', () => forkTraces().some((t) => t.trigger === 'cancel'), 30_000);
      const fork = forkTraces().find((t) => t.trigger === 'cancel')!;
      const framing = ((await framework.inspectAgentContext(fork.agentName)).getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: { kind?: string } }>)
        .find((m) => m.metadata?.kind === 'tune-out-reader-framing');
      const framingText = framing ? textOf(framing) : '(no framing)';
      console.log(`# PROBE-R2 dump: ${JSON.stringify(dump()!.replace(/\n/g, ' | '))}`);
      console.log(`# PROBE-R2 cancel fork held=${fork.held}; framing names HELD-1: ${framingText.includes('R2-HELD-1')}, HELD-2: ${framingText.includes('R2-HELD-2')}; notice: ${JSON.stringify((framingText.match(/\[Tune-out cancelled:[^\]]*\]/) ?? [''])[0])}`);

      release();
      const flushed = await waitFor('the held messages stored', () => i.deferredMessages.filter((m) => textOf(m as never).includes('R2-HELD')).length === 0, 30_000)
        .then(() => true, () => false);
      await new Promise((r) => setTimeout(r, 3_000));
      console.log(`# PROBE-R2 held messages left the deferred queue after the release: ${flushed}`);
      const scout = framework.getAgent('scout')!.getContextManager();
      const stored = scout.getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>;
      const compiled = await scout.compile();
      const inCompiled = (s: string) => compiled.messages.some((m) => textOf(m as never).includes(s));
      const storedHeld1 = stored.filter((m) => textOf(m).includes('R2-HELD-1') && !textOf(m).includes('<tuned-out-backlog'));
      console.log(`# PROBE-R2 after the turn: HELD-1 stored as its own row: ${storedHeld1.length}; in scout's compiled view as its own row: ${compiled.messages.some((m) => textOf(m as never).includes('R2-HELD-1') && !textOf(m as never).includes('<tuned-out-backlog'))}; HELD-1 in the compiled dump: ${compiled.messages.some((m) => textOf(m as never).includes('<tuned-out-backlog') && textOf(m as never).includes('R2-HELD-1'))}; HELD-2 anywhere compiled: ${inCompiled('R2-HELD-2')}`);
      const laterForks = forkTraces().filter((t) => t !== fork).map((t) => `${t.trigger}:${t.held}`);
      console.log(`# PROBE-R2 reader forks after the cancel fork: [${laterForks.join(', ')}]`);
    } finally {
      release();
      console.error = orig;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
