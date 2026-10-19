/**
 * Probes S5 and S6 for #546's review: a tune-out cancelled while tuned-out
 * messages are still held mid-turn, with a backlogCap below the held count.
 * The subconscious's cancel report covers what the dump leaves out; these
 * show what the dump and the report notice carry of the held messages.
 *
 * S5: two held in arrival order, cap 1: which one the dump shows, and
 *     whether the report notice carries the other.
 * S6: the same two, with the queue in the order a refused store write's
 *     requeue leaves it (the older behind the newer): which one the dump
 *     shows.
 *
 * Each logs a PROBE-S line and asserts what it shows at this head.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult } from '../../src/index.js';
import { AgentFramework } from '../../src/index.js';
import { MockMembrane, createMockResponse } from '../helpers/mock-membrane.js';
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

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: ContentBlock[] }> } }>;
  deferredMessages: Array<{ seq: number; content: ContentBlock[] }>;
  channelRegistry: { listChannelsRaw(): unknown[] } | null;
}

const textOf = (m: { content: ContentBlock[] }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function within<T>(what: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Two tuned-out messages held while the resident's turn waits on a tool,
 *  then a cancel with backlogCap 1; `reorder` puts the queue in the order a
 *  requeue leaves it first. */
async function cancelWithTwoHeld(tag: string, reorder: boolean): Promise<{ dump: string; notice: string; queueTexts: string[] }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'probe-546-held-cancel-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const module = new WaitModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{
      id: 'disc',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [module],
  });
  let release: () => void = () => {};
  try {
    await framework.start();
    const i = framework as unknown as Internals;
    await waitFor('channel registration', () => (i.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    assert.ok(i.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 1, maxWakes: 5 }, 'agent-tool').ok);

    let waiting!: () => void;
    const inTool = new Promise<void>((resolve) => { waiting = resolve; });
    module.hold = new Promise<void>((resolve) => { release = resolve; });
    module.onWait = waiting;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Waiting.' },
      { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
    await within("the resident's tool", inTool);

    const held = (): Array<{ seq: number; content: ContentBlock[] }> =>
      i.deferredMessages.filter((m) => textOf(m).includes(`${tag}-HELD`));
    appendFileSync(commandPath, `ambient ${tag}a ${tag}-HELD-1 chatter while the turn is alive\n`);
    await waitFor('the first held', () => held().length === 1);
    appendFileSync(commandPath, `ambient ${tag}b ${tag}-HELD-2 more chatter while the turn is alive\n`);
    await waitFor('the second held', () => held().length === 2);
    const [first, second] = held();
    assert.ok(textOf(first!).includes(`${tag}-HELD-1`) && first!.seq < second!.seq, 'premise: the queue is in seq order');
    if (reorder) i.deferredMessages.reverse();

    assert.ok(i.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'probe').ok);
    const dumpOf = (): string | undefined => i.deferredMessages.map(textOf).find((t) => t.includes('<tuned-out-backlog'));
    await waitFor('the dump', () => dumpOf() !== undefined);
    const sub = i.agents.get('Subconscious')!.getContextManager();
    const noticeOf = (): string | undefined => sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
    await waitFor("the subconscious's report notice", () => noticeOf() !== undefined);
    return { dump: dumpOf()!, notice: noticeOf()!, queueTexts: i.deferredMessages.map(textOf) };
  } finally {
    release();
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('probe S5-S6: a cancel while tuned-out messages are held, under a cap below the held count', () => {
  it('S5: the dump shows the newer; the report notice carries neither', async () => {
    const { dump, notice } = await cancelWithTwoHeld('S5', false);
    const shows = (t: string, n: number): boolean => t.includes(`S5-HELD-${n}`);
    console.log(`# PROBE-S5 ${JSON.stringify({ dumpShows1: shows(dump, 1), dumpShows2: shows(dump, 2), noticeCarries1: shows(notice, 1), noticeCarries2: shows(notice, 2), notice })}`);
    assert.ok(shows(dump, 2) && !shows(dump, 1), 'the dump shows the newer held message');
    assert.ok(!shows(notice, 1), "the report notice doesn't carry the older one");
  });

  it('S6: with the queue in requeue order, the dump shows the older', async () => {
    const { dump } = await cancelWithTwoHeld('S6', true);
    const shows = (n: number): boolean => dump.includes(`S6-HELD-${n}`);
    console.log(`# PROBE-S6 ${JSON.stringify({ dumpShows1: shows(1), dumpShows2: shows(2) })}`);
    assert.ok(shows(1) && !shows(2), 'the dump shows the older held message');
  });
});
