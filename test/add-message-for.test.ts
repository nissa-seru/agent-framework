/**
 * AgentFramework.addMessageFor: host code writes a message into a named
 * agent's window. It's held and lands as the framework's own writes for that
 * agent are (the forAgent path of the framework's write): held while the
 * host is quiesced, behind what's already held, until resume(); held while
 * that agent's turn is alive, until that agent's boundary; stored at once
 * otherwise. A name that isn't a registered agent throws, where the
 * framework's own write logs and drops.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { MalformedContentError } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    addMessage(
      participant: string,
      content: Array<{ type: 'text'; text: string }>,
      metadata?: Record<string, unknown>,
      opts?: { forAgent?: string },
    ): string;
    deferredMessages: Array<{ participant: string; content: ContentBlock[]; forAgent?: string }>;
    activeTurnTokens: Map<string, number>;
  };
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

function texts(framework: AgentFramework, agentName: string): string[] {
  return framework.getAgent(agentName)!.getContextManager().getAllMessages()
    .map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '');
}

function channelIncoming(body: string, targetAgents: string[]): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId: 'discord:guild:chanA',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: text(body),
    timestamp: new Date().toISOString(),
    metadata: {},
    triggerInference: true,
    targetAgents,
  } as unknown as ProcessEvent;
}

/** A tool whose call leaves the primary a note through addMessageFor while its round is pending. */
class NoteModule implements Module {
  readonly name = 'notes';
  framework: AgentFramework | null = null;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'note', description: 'Leave a note', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.framework!.addMessageFor('scout', 'host', text('mid-turn note'));
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: text('go') }], requestInference: true };
  }
}

describe('addMessageFor', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'add-message-for-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(extra: { subconscious?: boolean } = {}) {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'shade', model: 'test-model', systemPrompt: 'You are shade.' },
      ],
      ...(extra.subconscious ? { subconscious: { enabled: true, systemPrompt: 'notice' } } : {}),
      modules: [],
    });
  }

  it('stores a note for an idle agent at once, in its window', async () => {
    const framework = await makeFramework();
    framework.addMessageFor('shade', 'host', text('note for shade'));
    assert.ok(texts(framework, 'shade').includes('note for shade'));
    // The ordinary residents share one slot, so the primary reads it too.
    assert.ok(texts(framework, 'scout').includes('note for shade'));
    assert.equal(internals(framework).deferredMessages.length, 0);

    await framework.stop();
  });

  it('stores a note for an agent with a store of its own there, and only there', async () => {
    // The subconscious's own store is isolated; it reads the residents' slot
    // through a merged view.
    const framework = await makeFramework({ subconscious: true });
    framework.addMessageFor('Subconscious', 'host', text('note for the subconscious'));
    assert.ok(texts(framework, 'Subconscious').includes('note for the subconscious'));
    assert.ok(!texts(framework, 'scout').includes('note for the subconscious'));
    await framework.stop();
  });

  it('holds a note while the host is quiesced, behind what is already held, and lands it at resume', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    await framework.quiesce({ reason: 'test' });
    i.addMessage('user', [{ type: 'text', text: 'held first' }], undefined, { forAgent: 'shade' });
    framework.addMessageFor('shade', 'host', text('held second'));
    assert.deepEqual(
      i.deferredMessages.map((m) => [m.forAgent, (m.content[0] as { text?: string }).text]),
      [['shade', 'held first'], ['shade', 'held second']],
    );
    assert.ok(!texts(framework, 'shade').includes('held second'), 'not stored while quiesced');

    await framework.resume();
    const stored = texts(framework, 'shade');
    assert.ok(stored.indexOf('held first') >= 0 && stored.indexOf('held first') < stored.indexOf('held second'), JSON.stringify(stored));
    assert.equal(i.deferredMessages.length, 0);
    await framework.stop();
  });

  it("holds a note while that agent's turn is alive, past another agent's boundary, and lands it at its own", async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.activeTurnTokens.set('shade', 7);
    framework.addMessageFor('shade', 'host', text('note for busy shade'));
    assert.equal(i.deferredMessages.length, 1);
    assert.equal(i.deferredMessages[0].forAgent, 'shade');

    // The primary's turn doesn't flush shade's note.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout says hi' }]));
    framework.pushEvent(channelIncoming('wake scout', ['scout']));
    await framework.runUntilIdle();
    assert.equal(i.deferredMessages.length, 1, "shade's note survives the primary's boundary");
    assert.ok(!texts(framework, 'shade').includes('note for busy shade'));

    // Shade's own turn lands it.
    i.activeTurnTokens.delete('shade');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'shade replies' }]));
    framework.pushEvent(channelIncoming('wake shade', ['shade']));
    await framework.runUntilIdle();
    assert.equal(i.deferredMessages.length, 0);
    assert.ok(texts(framework, 'shade').includes('note for busy shade'));
    await framework.stop();
  });

  it("holds a note written during the agent's own tool round, and lands it after that round's results, where the live stream hears it", async () => {
    const module = new NoteModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [module],
    });
    module.framework = framework;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'n1', name: 'notes--note', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    // The live stream heard it with the round's results.
    const injected = membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [];
    assert.deepEqual(injected.map((m) => (m.content[0] as { text?: string }).text), ['mid-turn note']);
    // Stored after the round's results, before the reply that followed.
    const rows = framework.getAgent('scout')!.getContextManager().getAllMessages();
    const at = (pred: (m: (typeof rows)[number]) => boolean) => rows.findIndex(pred);
    const result = at((m) => m.content.some((b) => b.type === 'tool_result'));
    const note = at((m) => (m.content[0] as { text?: string }).text === 'mid-turn note');
    const reply = at((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'done'));
    assert.ok(result >= 0 && result < note && note < reply, JSON.stringify({ result, note, reply }));
    assert.equal(internals(framework).deferredMessages.length, 0);
    await framework.stop();
  });

  it('throws for a name that is no registered agent, naming it, and stores and holds nothing', async () => {
    const framework = await makeFramework();
    const before = texts(framework, 'scout').length;
    assert.throws(
      () => framework.addMessageFor('shdae', 'host', text('lost')),
      { message: 'addMessageFor: no registered agent is named "shdae"; the registered agents are "scout", "shade".' },
    );
    assert.equal(internals(framework).deferredMessages.length, 0);
    assert.equal(texts(framework, 'scout').length, before);
    await framework.stop();
  });

  it('throws for content holding a tool call or result, naming the block, and stores and holds nothing', async () => {
    const framework = await makeFramework();
    const before = texts(framework, 'scout').length;
    assert.throws(
      () => framework.addMessageFor('shade', 'host', [
        { type: 'text', text: 'see' },
        { type: 'tool_result', toolUseId: 't1', content: 'ok' },
      ] as unknown as ContentBlock[]),
      { message: 'addMessageFor: content[1] is a tool_result block; a note holds no tool call or result, since it has no call to pair with.' },
    );
    assert.throws(
      () => framework.addMessageFor('shade', 'host', [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] as unknown as ContentBlock[]),
      { message: 'addMessageFor: content[0] is a tool_use block; a note holds no tool call or result, since it has no call to pair with.' },
    );
    // Held while quiesced or not, a tool result would have skipped the hold.
    await framework.quiesce({ reason: 'test' });
    assert.throws(() => framework.addMessageFor('shade', 'host', [{ type: 'tool_result', toolUseId: 't3', content: 'ok' }] as unknown as ContentBlock[]));
    assert.equal(internals(framework).deferredMessages.length, 0);
    assert.equal(texts(framework, 'scout').length, before);
    await framework.resume();
    await framework.stop();
  });

  it("throws for content the store won't take, as a module's write does", async () => {
    const framework = await makeFramework();
    assert.throws(
      () => framework.addMessageFor('shade', 'host', [{ type: 'text', text: 5 }] as unknown as ContentBlock[]),
      MalformedContentError,
    );
    assert.equal(internals(framework).deferredMessages.length, 0);
    await framework.stop();
  });
});
