/**
 * Milo-2653's probes of #546's admission and tune-out (review only, not for the PR).
 * Each prints what happened; the assertions are only that the rig ran.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import { say } from './helpers/dendrite.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import {
  SUB, internals, held, find, has, MENTION, incoming, dm, registerOpen, enter, settle,
} from './helpers/admission.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function enterAllExcept(f: Parameters<typeof internals>[0], except: string) {
  const r = internals(f).tuneOutCoordinator!.enterAllExcept(
    { serverId: 'editor', channelId: except }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool',
  );
  assert.ok(r.ok, `all-except: ${(r as { error?: string }).error ?? ''}`);
}

function gateTraces(f: Parameters<typeof internals>[0]) {
  const seen: Array<Record<string, unknown>> = [];
  const off = f.framework.onTrace((t) => {
    const type = String((t as { type: string }).type);
    if (type.startsWith('gate:') || type === 'admission:decided' || type === 'inference:started') seen.push(t as Record<string, unknown>);
  });
  return { seen, off };
}

describe('PROBE #546 gate re-check', () => {
  it('P1: a mention batched by a debounce before its channel is tuned out — does its wake run (decision 3)?', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        gate: { config: { default: 'always', policies: [
          { name: 'noisy-debounce', match: { scope: ['mcpl:channel-incoming'], channel: 'noisy' }, behavior: { debounce: 300 } },
        ] } },
      } as Partial<FrameworkConfig>,
    });
    const t = gateTraces(f);
    try {
      await registerOpen(f, 'noisy');
      await incoming(f, 'noisy', 'c1', 'hey agent, before the hold', MENTION);
      await settle(f);
      const gate = internals(f).eventGate!;
      console.log(`PROBE P1 batched=${gate.debounceTimers.size} storedHeld=${held(find(f, 'before the hold'))}`);
      enter(f, 'noisy');
      const before = f.membrane.calls.length;
      f.membrane.pushResponse(say('woke for the batch'));
      await sleep(900);
      await f.framework.runUntilIdle();
      const types = t.seen.map((x) => x.type).filter((x) => x !== 'admission:decided');
      console.log(`PROBE P1 residentRequestsAfterDebounce=${f.membrane.calls.length - before} traces=${JSON.stringify(types)}`);
    } finally { t.off(); await f.close(); }
  });

  it('P2a: a DM batched by a debounce, then the DM tuned out per channel — dropped or woken?', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        gate: { config: { default: 'always', policies: [
          { name: 'push-debounce', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 300 } },
        ] } },
      } as Partial<FrameworkConfig>,
    });
    const t = gateTraces(f);
    try {
      await dm(f, 'dm-0', 'a dm before the hold');
      await settle(f);
      const gate = internals(f).eventGate!;
      console.log(`PROBE P2a batched=${gate.debounceTimers.size} stored=${has(f, 'a dm before the hold')}`);
      enter(f, 'discord:dm:777');
      const before = f.membrane.calls.length;
      f.membrane.pushResponse(say('woke for the dm batch'));
      await sleep(900);
      await f.framework.runUntilIdle();
      const types = t.seen.map((x) => x.type).filter((x) => x !== 'admission:decided');
      const dropped = t.seen.filter((x) => x.type === 'gate:held-dropped');
      console.log(`PROBE P2a residentRequestsAfterDebounce=${f.membrane.calls.length - before} traces=${JSON.stringify(types)} dropped=${JSON.stringify(dropped)}`);
    } finally { t.off(); await f.close(); }
  });

  it('P2b: focus on the DM (all-except, the DM excepted); a DM arrives and is debounced — does its wake run?', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        gate: { config: { default: 'always', policies: [
          { name: 'push-debounce', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 300 } },
        ] } },
      } as Partial<FrameworkConfig>,
    });
    const t = gateTraces(f);
    try {
      await registerOpen(f, 'work');
      enterAllExcept(f, 'discord:dm:777');
      await dm(f, 'dm-1', 'a dm in the focused conversation');
      await settle(f);
      const gate = internals(f).eventGate!;
      const decided = t.seen.filter((x) => x.type === 'admission:decided').map((x) => ({ lane: x.lane, channelId: x.channelId, held: x.held, wake: x.wake }));
      console.log(`PROBE P2b admission=${JSON.stringify(decided)} batched=${gate.debounceTimers.size} storedHeld=${held(find(f, 'focused conversation'))}`);
      const before = f.membrane.calls.length;
      f.membrane.pushResponse(say('woke for the focused dm'));
      await sleep(900);
      await f.framework.runUntilIdle();
      const types = t.seen.map((x) => x.type).filter((x) => x !== 'admission:decided');
      const dropped = t.seen.filter((x) => x.type === 'gate:held-dropped');
      console.log(`PROBE P2b residentRequestsAfterDebounce=${f.membrane.calls.length - before} traces=${JSON.stringify(types)} dropped=${JSON.stringify(dropped)}`);
    } finally { t.off(); await f.close(); }
  });
});

describe('PROBE #546 conversation routing under the scope', () => {
  it('P5: all-except on work; ambient traffic in noisy with channel conversations bound always', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        conversations: { templateAgent: 'agent', bind: { channel: 'always' } },
      } as unknown as Partial<FrameworkConfig>,
    });
    const t = gateTraces(f);
    const seen: string[] = [];
    const off = f.framework.onTrace((x) => {
      const type = String((x as { type: string }).type);
      if (type.startsWith('mcpl:conversation') || type.startsWith('tune-out:') || type === 'admission:decided') {
        seen.push(`${type}:${JSON.stringify({ ch: (x as { channelId?: string }).channelId, agent: (x as { agentName?: string }).agentName, held: (x as { held?: unknown }).held })}`);
      }
    });
    try {
      await registerOpen(f, 'work', 'noisy');
      enterAllExcept(f, 'work');
      f.membrane.pushResponse(say('[unexpected fork turn]'));
      await incoming(f, 'noisy', 'n1', 'noise while focused', ['chat:ambient', 'chat:from-human']);
      await f.framework.runUntilIdle();
      const agents = f.framework.listAgents().map((r) => r.name);
      console.log(`PROBE P5 agents=${JSON.stringify(agents)} traces=${JSON.stringify(seen)}`);
      const forkName = agents.find((n) => n !== 'agent' && n !== 'Subconscious');
      if (forkName) {
        const fork = f.framework.getAgent(forkName)!;
        const inSlot = (fork.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>)
          .filter((m) => JSON.stringify(m.content).includes('noise while focused'));
        const compiled = await fork.getContextManager().compile();
        const inView = compiled.messages.some((m) => JSON.stringify((m as { content: unknown }).content).includes('noise while focused'));
        console.log(`PROBE P5 fork=${forkName} storedInForkSlot=${inSlot.length} stamped=${inSlot.some((m) => !!(m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut)} inForkCompiledView=${inView}`);
      }
      console.log(`PROBE P5 inResidentSlot=${has(f, 'noise while focused')}`);
      const r = internals(f).tuneOutCoordinator!.cancelAllExcept('test', 'probe');
      const release = (f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>)
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-cancel');
      console.log(`PROBE P5 cancel=${JSON.stringify(r)} release=${JSON.stringify(release.map((m) => m.content.map((b) => b.text).join(' ').slice(0, 300)))}`);
    } finally { off(); t.off(); await f.close(); }
  });
});

describe('PROBE #546 mail-woken locus', () => {
  for (const scoped of [false, true]) {
    it(`P3 ${scoped ? 'under' : 'without'} the all-except scope: where does a turn woken by the reader's mail speak?`, async () => {
      const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
      const t = gateTraces(f);
      try {
        await registerOpen(f, 'work', 'noisy');
        if (scoped) enterAllExcept(f, 'work');
        const reader = f.framework.listAgents().map((r) => r.name).find((n) => n !== 'agent');
        console.log(`PROBE P3 scoped=${scoped} agents=${JSON.stringify(f.framework.listAgents().map((r) => r.name))}`);
        f.membrane.pushResponse(say('thanks, reader'));
        const before = t.seen.length;
        f.framework.sendAgentMessage(reader!, 'agent', [{ type: 'text', text: 'Held: two lines in noisy, nothing urgent.' }]);
        await f.framework.runUntilIdle();
        const started = t.seen.slice(before).filter((x) => x.type === 'inference:started' && x.agentName === 'agent');
        console.log(`PROBE P3 scoped=${scoped} residentTurns=${started.length} locus=${JSON.stringify(started.map((x) => x.channelId ?? null))}`);
      } finally { t.off(); await f.close(); }
    });
  }
});
