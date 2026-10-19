/**
 * Probes for agent-framework #546 (Dendrite) at 220f4cff: findings 4 and 5 of
 * the review comment, by Hilda-2681. Not part of the PR.
 *
 * 4. Boot: reconcileAgentRegistry redelivers held mail (and writes lifecycle
 *    notices) through addMessage before create() restores host mode and the
 *    deferred queue. Predicted: on a quiesced restart those land at boot, and
 *    mail the queue also holds lands a second time at resume.
 * 5. stopAgent tears a fork down without releasing its window (main's
 *    disposal path does release it). Predicted: an unread failure notice in
 *    its window never reaches the primary, and a write queued for it stays
 *    queued until a flush drops it.
 *
 * Each "probe" test asserts the predicted behaviour, so a pass shows it and a
 * failure shows the prediction was wrong. Each "control" test asserts what
 * main's rule gives on the same head. Observed values are logged as JSON.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import { AgentFramework, workerSpec } from '../../src/index.js';
import type { AgentSpec, ProcessEvent } from '../../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import { GateModule, RoutedMembrane, say, until, waitCall } from '../helpers/dendrite.js';
import { MockMembrane, createMockResponse } from '../helpers/mock-membrane.js';

const textOf = (content: ContentBlock[]) =>
  content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('');

function rowsWith(framework: AgentFramework, agent: string, needle: string) {
  return framework.getAgent(agent)!.getContextManager().getAllMessages()
    .filter((message) => textOf(message.content).includes(needle));
}

describe('probe 4: boot redelivery against a quiesced restart', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hilda-546-boot-'));
    membrane = new RoutedMembrane();
    frameworks = [];
  });

  afterEach(async () => {
    for (const framework of frameworks.reverse()) {
      try { await framework.stop(); } catch { /* already stopped */ }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const storePath = () => join(tempDir, 'store.chronicle');
  const queueFile = () => join(storePath(), 'recovery', 'deferred-writes.json');

  async function boot(gates = new GateModule()): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: storePath(),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [gates],
      syncIntervalMs: 0,
    });
    frameworks.push(framework);
    return framework;
  }

  function queued(needle: string): number {
    if (!existsSync(queueFile())) return 0;
    const queue = JSON.parse(readFileSync(queueFile(), 'utf8')) as { pending?: unknown[] };
    return (queue.pending ?? []).filter((entry) => JSON.stringify(entry).includes(needle)).length;
  }

  it('probe 4a: held mail lands at a quiesced boot, then lands again at resume; a plain write waits', async () => {
    const first = await boot();
    await first.quiesce({ reason: 'maintenance' });
    const sent = first.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'MAIL-1' }]);
    (first as unknown as {
      addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>, o?: { forAgent?: string }): string;
    }).addMessage('user', [{ type: 'text', text: 'PLAIN-1' }], { kind: 'test-note' }, { forAgent: 'mira' });
    const beforeStop = {
      sent,
      mailRows: rowsWith(first, 'mira', 'MAIL-1').length,
      plainRows: rowsWith(first, 'mira', 'PLAIN-1').length,
      heldMail: first.listHeldMail().length,
    };
    await first.stop();
    const inQueueFile = { mail: queued('MAIL-1'), plain: queued('PLAIN-1') };

    const second = await boot();
    const atBoot = {
      quiesced: second.getHostModeStatus().quiesced,
      mailRows: rowsWith(second, 'mira', 'MAIL-1').length,
      plainRows: rowsWith(second, 'mira', 'PLAIN-1').length,
      heldMail: second.listHeldMail().length,
    };
    await second.resume();
    const afterResume = {
      mailRows: rowsWith(second, 'mira', 'MAIL-1').length,
      plainRows: rowsWith(second, 'mira', 'PLAIN-1').length,
      mailIds: rowsWith(second, 'mira', 'MAIL-1').map((m) => ({
        mailId: (m.metadata as { dendrite?: { mailId?: string } } | undefined)?.dendrite?.mailId,
        deferredWriteId: (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId ?? null,
      })),
    };
    console.log('PROBE-4a', JSON.stringify({ beforeStop, inQueueFile, atBoot, afterResume }));

    assert.equal(beforeStop.mailRows, 0, 'held by the quiesce before the restart');
    assert.equal(beforeStop.heldMail, 1);
    assert.deepEqual(inQueueFile, { mail: 1, plain: 1 }, 'both in the durable queue at the restart');
    assert.equal(atBoot.quiesced, true, 'the host boots quiesced');
    assert.equal(atBoot.plainRows, 0, 'control: the queue holds an ordinary write until resume');
    assert.equal(atBoot.mailRows, 1, 'predicted: the registry lands the mail at boot, on a quiesced host');
    assert.equal(afterResume.plainRows, 1, 'control: the ordinary write lands once, at resume');
    assert.equal(afterResume.mailRows, 2, 'predicted: the queue lands the same mail a second time at resume');
  });

  it('probe 4b: an interrupted job\'s "host restarted" notice lands at a quiesced boot', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    membrane.script('job', waitCall('job'), say('job done'));
    const spec: Omit<AgentSpec, 'name'> = workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } });
    const { agent, contextManager } = await first.createEphemeralAgent(
      { name: 'job', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      spec,
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    first.runEphemeralToCompletion(agent, contextManager).catch(() => { /* cut off by the restart */ });
    await until(() => gates.entered.has('job'), 'job to block');
    // The job is mid-tool, so the drain times out and the host stays quiesced, undrained.
    const quiesce = await first.quiesce({ reason: 'maintenance', timeoutMs: 1_000 });
    await first.stop();

    const second = await boot();
    const notices = second.getAgent('mira')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-lifecycle')
      .map((m) => textOf(m.content));
    const atBoot = {
      quiescedBeforeStop: quiesce.quiesced,
      quiesced: second.getHostModeStatus().quiesced,
      jobEnded: second.getAgentRecord('job')?.ended?.reason ?? null,
      notices,
    };
    console.log('PROBE-4b', JSON.stringify(atBoot));

    assert.equal(atBoot.quiesced, true, 'the host boots quiesced');
    assert.equal(atBoot.jobEnded, 'host-restart');
    assert.equal(notices.length, 1, 'predicted: the notice is written into mira\'s window at boot, while quiesced');
  });
});

function internals(framework: AgentFramework) {
  return framework as unknown as {
    initializeMcpl(servers: []): Promise<void>;
    activeTurnTokens: Map<string, number>;
    deferredMessages: Array<{ forAgent?: string; metadata?: Record<string, unknown> }>;
    pendingAssistantBlocks: Map<string, unknown[]>;
    lastConversationSweep: number;
    sweepExpiredConversations(): void;
    quiesced: boolean;
    deferredWritesPersisted: boolean;
    unackedDeferredWrites: unknown[];
    flushDeferredWrites(label: string): Promise<void>;
    closingConversationAgents: Set<string>;
    addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  };
}

const SEND_FAILED = '[discord-send-failed]';
const count = (messages: Array<{ content: unknown }>, needle: string) =>
  messages.filter((m) => JSON.stringify(m.content).includes(needle)).length;

describe('probe 5: stopAgent against the window release', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hilda-546-stop-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
        { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
      ],
      modules: [],
      conversations: { templateAgent: 'primary' },
      speech: { locus: 'latest-inbound' },
    });
    await internals(framework).initializeMcpl([]);
  });

  afterEach(async () => {
    internals(framework).activeTurnTokens.clear();
    internals(framework).pendingAssistantBlocks.clear();
    internals(framework).quiesced = false;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A real conversation fork, as route-failure-targeting's: its reply fails (no such channel). */
  async function spawnFork(reply = 'Reply from the fork.') {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: reply }]));
    framework.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'srv',
      channelId: 'missing-channel',
      messageId: 'incoming-1',
      author: { id: 'user-1', name: 'User' },
      content: [{ type: 'text', text: 'Hello fork.' }],
      timestamp: new Date().toISOString(),
      metadata: { channel_type: 'im' },
      triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const binding = framework.getConversationRouter()!.getBinding('missing-channel');
    assert.ok(binding, 'the incoming DM must spawn a real conversation fork');
    return framework.getAgent(binding.agentName)!;
  }

  /** The fallback reaper over a closing fork, as route-failure-targeting's reap(). */
  function reap(forkName: string) {
    const state = internals(framework);
    state.closingConversationAgents.add(forkName);
    state.lastConversationSweep = 0;
    state.sweepExpiredConversations();
  }

  async function forkWindowHas(forkName: string, needle: string): Promise<boolean> {
    const archive = await ContextManager.open({
      store: framework.getStore(), namespace: 'conversations/' + forkName, isolate: true, strategy: new PassthroughStrategy(),
    });
    return archive.getAllMessages().some((m) => JSON.stringify(m.content).includes(needle));
  }

  for (const how of ['reap (control)', 'stopAgent (probe)'] as const) {
    it(`5a, ${how}: a failure notice the fork stored but never read`, async () => {
      const fork = await spawnFork();
      const kind = framework.getAgentRecord(fork.name)?.kind ?? null;
      if (how.startsWith('reap')) reap(fork.name);
      else framework.stopAgent(fork.name, { by: 'probe', reason: 'probe' });

      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const observed = { kind, gone: framework.getAgent(fork.name) === null, primaryTold: count(messages, SEND_FAILED) };
      console.log('PROBE-5a', how, JSON.stringify(observed));
      assert.equal(observed.gone, true);
      if (how.startsWith('reap')) assert.equal(observed.primaryTold, 1, 'control: the release tells the primary');
      else assert.equal(observed.primaryTold, 0, 'predicted: no release, so the primary is never told');
    });

    it(`5b, ${how}: an ordinary write queued for the fork`, async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const fork = await spawnFork();
      const state = internals(framework);
      state.deferredWritesPersisted = true;
      state.activeTurnTokens.set(fork.name, 3);
      state.addMessage('user', [{ type: 'text', text: 'queued for the fork' }], { kind: 'test-note' }, { forAgent: fork.name });
      assert.equal(state.deferredMessages.length, 1);
      state.activeTurnTokens.delete(fork.name);

      if (how.startsWith('reap')) reap(fork.name);
      else framework.stopAgent(fork.name, { by: 'probe', reason: 'probe' });
      const afterEnd = {
        gone: framework.getAgent(fork.name) === null,
        queued: state.deferredMessages.length,
        unacked: state.unackedDeferredWrites.length,
        inForkWindow: await forkWindowHas(fork.name, 'queued for the fork'),
      };
      await state.flushDeferredWrites('probe');
      const afterFlush = {
        queued: state.deferredMessages.length,
        unacked: state.unackedDeferredWrites.length,
        inForkWindow: await forkWindowHas(fork.name, 'queued for the fork'),
        dropLogged: errors.some((e) => /is not a registered agent — message dropped/.test(e)),
      };
      console.log('PROBE-5b', how, JSON.stringify({ afterEnd, afterFlush }));
      assert.equal(afterEnd.gone, true);
      if (how.startsWith('reap')) {
        assert.deepEqual(afterEnd, { gone: true, queued: 0, unacked: 0, inForkWindow: true }, 'control: released into its window, acked');
      } else {
        assert.equal(afterEnd.queued, 1, 'predicted: still queued after the stop');
        assert.equal(afterEnd.inForkWindow, false);
        assert.deepEqual(
          { queued: afterFlush.queued, inForkWindow: afterFlush.inForkWindow, dropLogged: afterFlush.dropLogged },
          { queued: 0, inForkWindow: false, dropLogged: true },
          'predicted: the next flush drops it, logged: in neither the window nor the queue',
        );
      }
    });
  }
});
