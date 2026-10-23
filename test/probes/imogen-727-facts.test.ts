/**
 * Facts for agent-framework #727 (a batched wake writes its `[Gate: …]` line
 * only when it says something), run at main 9fdc3a65 and at
 * the PR's head 307e0be5 over the PR's own end-to-end rig (the wake-locus
 * MCPL fixture, addressed messages through a 300 ms debounce). Each test logs
 * what it saw on a FACT-<n> line and asserts only the rig's premises, so it
 * passes on both trees; the facts are the logged lines, compared.
 *
 * Predictions, written before any run:
 * 1. The race. A DM's batch fires and, before the agent's turn compiles, an
 *    ambient message is stored. At main the request's tail is the DM, the
 *    line naming the DM, then the ambient message. At 307e0be5 it is the DM
 *    then the ambient message, with no line: nothing in the request says the
 *    wake is for the DM rather than the ambient message.
 * 2. The agent's seat. One DM, nothing after it. At main the request ends
 *    with the line, right under the DM. At 307e0be5 it ends with the DM, and
 *    nothing else in the request marks the turn as a wake for it.
 * 4. (Added after the first run showed a `[routing]` notice closing the
 *    first wake's request, naming the DM's channel.) A second DM's wake, once
 *    the locus is already that DM: at 307e0be5 the request ends with the
 *    second DM and nothing after it, with no `[routing]` notice; with an
 *    ambient message stored before the compile, it ends with the ambient
 *    message, and nothing says the wake is for the DM.
 * 5. (Added after the first four ran; written before its own run.) The window
 *    between the gate's decision and the compile, widened by a provider
 *    cooldown hold (the framework's own providerAccelerationCooldowns entry
 *    and release path, injected for 2 s), on a later wake (locus already the
 *    DM). During the hold, a real guild message arrives through the fixture.
 *    a) Ambient. At 307e0be5 the request ends with the DM, then the ambient
 *       message, with no line; the reply publishes to the DM channel. At
 *       main, the line naming the DM sits between them.
 *    b) Addressed (a mention from someone else in #general). Its own batch is
 *       decided during the hold too. At 307e0be5 neither wake has a line: the
 *       request ends DM, mention, and the reply publishes to one channel. At
 *       main both lines are in the window.
 * 3. Held. The same DM stored as held by a tune-out (metadata.tuneOut). The
 *    line is written at both trees, so the wake is never line-less for a
 *    message the agent can't see.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../../src/index.js';
import { MockMembrane, createMockResponse } from '../helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures/wake-locus-mcpl-server.mjs');
const RAW_DM = '1548000000000000001';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Internals = {
  eventGate: { fireDebounce(policyName: string): void } | null;
  addMessage(participant: string, content: Array<{ type: string; text?: string }>, metadata?: Record<string, unknown>, opts?: Record<string, unknown>): unknown;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }> } }>;
  channelRegistry: { listChannelsRaw(): unknown[] };
};

describe('#727 facts', () => {
  let tempDir: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'imogen-727-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: {
        config: {
          policies: [{
            name: 'addressed',
            match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'], tagsAny: ['chat:addressed'] },
            behavior: { debounce: 300 },
          }],
          default: 'skip',
        },
      },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const internals = framework as unknown as Internals;
    await waitFor(() => internals.channelRegistry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const dm = (text: string): void => appendFileSync(commandPath, `dm ev-${++n} 134 ${RAW_DM} ${text}\n`);
  const internals = () => framework as unknown as Internals;
  const textOf = (content: unknown): string => Array.isArray(content)
    ? content.map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : `<${b.type}>`)).join(' ')
    : String(content);
  /** A request's last `k` messages, as participant: text (cut at 90 chars). */
  const requestTail = (k: number, call = 0): string[] => {
    const request = membrane.calls[call] as unknown as { messages: Array<{ participant: string; content: unknown }> };
    return request.messages.slice(-k).map((m) => `${m.participant}: ${textOf(m.content).replace(/\s+/g, ' ').slice(0, 90)}`);
  };
  const windowGateLines = (): number => internals().agents.get('scout')!.getContextManager().getAllMessages()
    .filter((m) => textOf(m.content).includes('[Gate:')).length;

  it('fact 1: an ambient message stored between the gate\'s decision and the compile', async () => {
    const gate = internals().eventGate;
    assert.ok(gate, 'premise: a gate');
    const fire = gate.fireDebounce.bind(gate);
    gate.fireDebounce = (policyName) => {
      fire(policyName);
      // Right after the gate decided and requested the wake, before the event loop compiles the turn.
      internals().addMessage('Lurker', [{ type: 'text', text: 'AMBIENT unrelated chatter' }], { kind: 'probe-ambient' });
    };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('DM are you there?');
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    const observed = { gateLinesInWindow: windowGateLines(), requestTail: requestTail(4) };
    console.log('FACT-1', JSON.stringify(observed));
    assert.ok(observed.requestTail.some((t) => t.includes('DM are you there?')), 'premise: the DM is in the request');
  });

  it('fact 2: one DM with nothing after it — what the request says the turn is for', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('DM are you there?');
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    const request = membrane.calls[0] as unknown as { messages: unknown[]; system?: unknown };
    const observed = {
      gateLinesInWindow: windowGateLines(),
      messages: request.messages.length,
      requestTail: requestTail(3),
    };
    console.log('FACT-2', JSON.stringify(observed));
    assert.ok(observed.requestTail.some((t) => t.includes('DM are you there?')), 'premise: the DM is in the request');
  });

  it('fact 3: the same DM stored as held by a tune-out', async () => {
    const original = internals().addMessage.bind(framework);
    internals().addMessage = (participant, content, metadata, opts) => {
      const held = content.some((b) => b.type === 'text' && (b.text ?? '').includes('HELD-DM'));
      return original(participant, content, held ? { ...metadata, tuneOut: { epochId: 'probe-epoch' } } : metadata, opts);
    };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('HELD-DM are you there?');
    let woke = true;
    try {
      await waitFor(() => membrane.calls.length >= 1, 'the wake', 3_000);
    } catch {
      woke = false;
    }
    const stored = internals().agents.get('scout')!.getContextManager().getAllMessages()
      .filter((m) => textOf(m.content).includes('HELD-DM')).map((m) => m.metadata?.tuneOut ?? null);
    const observed = {
      woke,
      storedHeld: stored,
      gateLinesInWindow: windowGateLines(),
      requestTail: woke ? requestTail(3) : null,
    };
    console.log('FACT-3', JSON.stringify(observed));
    assert.equal(stored.length, 1, 'premise: the DM is stored');
  });

  it('fact 4: a second DM\'s wake, once the locus is that DM, without and then with an ambient message before the compile', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('DM one');
    await waitFor(() => membrane.calls.length >= 1, 'the first wake');
    await framework.runUntilIdle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello again' }]));
    dm('DM two');
    await waitFor(() => membrane.calls.length >= 2, 'the second wake');
    await framework.runUntilIdle();
    const second = requestTail(3, 1);
    const gate = internals().eventGate!;
    const fire = gate.fireDebounce.bind(gate);
    gate.fireDebounce = (policyName) => {
      fire(policyName);
      internals().addMessage('Lurker', [{ type: 'text', text: 'AMBIENT unrelated chatter' }], { kind: 'probe-ambient' });
    };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'and again' }]));
    dm('DM three');
    await waitFor(() => membrane.calls.length >= 3, 'the third wake');
    const third = requestTail(3, 2);
    console.log('FACT-4', JSON.stringify({ gateLinesInWindow: windowGateLines(), second, third }));
    assert.ok(second.some((t) => t.includes('DM two')), 'premise: the second DM is in its request');
    assert.ok(third.some((t) => t.includes('DM three')), 'premise: the third DM is in its request');
  });

  for (const mode of ['ambient', 'addressed'] as const) {
    it(`fact 5${mode === 'ambient' ? 'a' : 'b'}: a provider hold between the decision and the compile, with an ${mode} guild message during it`, async () => {
      const fw = framework as unknown as Internals & {
        providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
        releaseProviderAccelerationCooldown(name: string): void;
      };
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
      dm('DM one');
      await waitFor(() => membrane.calls.length >= 1, 'the first wake');
      await framework.runUntilIdle();
      const gate = fw.eventGate!;
      const fire = gate.fireDebounce.bind(gate);
      let decided = 0;
      gate.fireDebounce = (policyName) => { fire(policyName); decided++; };
      const now = Date.now();
      const timer = setTimeout(() => fw.releaseProviderAccelerationCooldown('scout'), 2_000);
      fw.providerAccelerationCooldowns.set('scout', { startedAt: now, until: now + 2_000, timer, heldRequests: [], reason: 'probe hold', failures: 1 });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply after the hold' }]));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'a second reply' }]));
      dm('DM two');
      await waitFor(() => decided >= 1, 'the DM\'s decision');
      appendFileSync(commandPath, `incoming discord:g1:general m-g${n} ${mode} GUILD ${mode} message from someone\n`);
      await waitFor(() => internals().agents.get('scout')!.getContextManager().getAllMessages()
        .some((m) => textOf(m.content).includes(`GUILD ${mode}`)), 'the guild message stored');
      if (mode === 'addressed') await waitFor(() => decided >= 2, 'the mention\'s decision');
      const callsBefore = membrane.calls.length;
      await waitFor(() => membrane.calls.length >= 2, 'the held wake', 8_000);
      await framework.runUntilIdle();
      await new Promise((r) => setTimeout(r, 600));
      const publishes = readFileSync(join(tempDir, 'status.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; channelId?: string }).filter((e) => e.event === 'publish').map((e) => e.channelId);
      const observed = {
        decided, callsWhenHoldEnded: callsBefore, calls: membrane.calls.length,
        gateLinesInWindow: windowGateLines(),
        heldWakeTail: requestTail(6, 1),
        laterTail: membrane.calls.length >= 3 ? requestTail(3, 2) : null,
        publishes,
      };
      console.log(`FACT-5${mode === 'ambient' ? 'a' : 'b'}`, JSON.stringify(observed));
      assert.ok(observed.heldWakeTail.some((t) => t.includes('DM two')), 'premise: the DM is in the held wake\'s request');
    });
  }
});
