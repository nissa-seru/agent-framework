/**
 * Probes for agent-framework #546 at 220f4cff: how held channel traffic is
 * stored, against the inbox proposal in #232's discussion (Oct 6). Not part
 * of the PR. Each test logs what it saw on a PROBE-S line and asserts the
 * behaviour read from the code, so a pass confirms the reading.
 *
 * S1. Two residents share one message slot, and a hold is decided for the
 *     slot: a held message is stored, hidden, where both read, and neither
 *     resident's compiled view shows it.
 * S2. The release appends a capped dump. The stored originals stay hidden,
 *     and the oldest beyond backlogCap aren't delivered.
 * S3. A restart keeps held messages: they're stored, and the release after
 *     the restart still carries them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../../src/types/framework.js';
import { SUB, internals, textOf, stored, held, AMBIENT, registerOpen, enter, incoming, settle } from '../helpers/admission.js';

const TWO_RESIDENTS = [
  { name: 'agent', model: 'test', systemPrompt: 'test' },
  { name: 'other', model: 'test', systemPrompt: 'test' },
];

async function compiledTexts(f: Awaited<ReturnType<typeof fixture>>, agent: string): Promise<string[]> {
  const { messages } = await f.framework.getAgent(agent)!.getContextManager().compile();
  return messages.map((m) => JSON.stringify(m.content));
}

describe('probe S: where #546 keeps held channel traffic', () => {
  it('S1: two residents, one slot, one hold: the held message is stored hidden where both read', async () => {
    const f = await fixture({ agents: TWO_RESIDENTS, framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      // The open channel's message may wake the residents; answer every turn.
      f.alwaysRespond();
      await incoming(f, 'noisy', 's1', 'S1-HELD chatter in noisy', AMBIENT);
      await incoming(f, 'work', 's2', 'S1-OPEN chatter in work', AMBIENT);
      await f.framework.runUntilIdle();
      const observed: Record<string, unknown> = {};
      for (const agent of ['agent', 'other']) {
        const raw = stored(f, agent);
        const heldRow = raw.find((m) => textOf(m).includes('S1-HELD'));
        const compiled = await compiledTexts(f, agent);
        observed[agent] = {
          rawRows: raw.length,
          heldStored: !!heldRow,
          heldStamped: heldRow ? held(heldRow) : null,
          heldInCompiled: compiled.some((t) => t.includes('S1-HELD')),
          openInCompiled: compiled.some((t) => t.includes('S1-OPEN')),
        };
      }
      const sameSlot = JSON.stringify(stored(f, 'agent').map((m) => textOf(m))) === JSON.stringify(stored(f, 'other').map((m) => textOf(m)));
      console.log('PROBE-S1', JSON.stringify({ sameSlot, ...observed }));
      assert.equal(sameSlot, true, 'both residents read one slot');
      for (const agent of ['agent', 'other']) {
        assert.deepEqual(observed[agent], { ...(observed[agent] as object), heldStored: true, heldStamped: true, heldInCompiled: false, openInCompiled: true });
      }
    } finally { await f.close(); }
  });

  it('S2: the release appends a capped dump, and the stored originals stay hidden', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 2 });
      await incoming(f, 'noisy', 'c1', 'S2-ONE', AMBIENT);
      await incoming(f, 'noisy', 'c2', 'S2-TWO', AMBIENT);
      await incoming(f, 'noisy', 'c3', 'S2-THREE', AMBIENT);
      await settle(f);
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'probe').ok);
      const raw = stored(f);
      const dump = raw.find((m) => textOf(m).includes('<tuned-out-backlog'));
      const dumpText = dump ? textOf(dump) : '';
      const compiled = await compiledTexts(f, 'agent');
      const originalsInCompiled = ['S2-ONE', 'S2-TWO', 'S2-THREE'].filter((t) => compiled.some((c) => c.includes(t) && !c.includes('tuned-out-backlog')));
      const observed = {
        originalsStillStamped: raw.filter((m) => /S2-(ONE|TWO|THREE)/.test(textOf(m)) && !textOf(m).includes('tuned-out-backlog')).map(held),
        originalsInCompiled,
        dumpAttrs: (dumpText.match(/<tuned-out-backlog [^>]*>/) ?? [''])[0],
        inDump: ['S2-ONE', 'S2-TWO', 'S2-THREE'].filter((t) => dumpText.includes(t)),
        dumpIsLastRow: raw.at(-1) === dump || raw.slice(-3).includes(dump!),
      };
      console.log('PROBE-S2', JSON.stringify(observed));
      assert.deepEqual(observed.originalsStillStamped, [true, true, true], 'the originals keep their stamp after the release');
      assert.deepEqual(observed.originalsInCompiled, [], 'and stay out of the compiled view');
      assert.deepEqual(observed.inDump, ['S2-TWO', 'S2-THREE'], 'the dump carries the newest backlogCap');
      assert.match(observed.dumpAttrs, /messages=3 truncated=1/);
    } finally { await f.close(); }
  });

  it('S4: a module reading the slot gets the held row, stamped, and a held:true filter keeps it', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy');
      await incoming(f, 'noisy', 'm1', 'S4-HELD chatter in noisy', AMBIENT);
      await settle(f);
      // The function modules get as ctx.queryMessages (framework.ts:2830).
      const query = (f.framework as unknown as {
        queryMessages(filter: object): { messages: Array<Record<string, unknown>> };
      }).queryMessages({});
      const isHeldText = (m: Record<string, unknown>): boolean => JSON.stringify(m.content).includes('S4-HELD');
      const row = query.messages.find(isHeldText);
      // connectome-host's retrieval module: drop held:true rows, take the last 10 (retrieval-module.ts:460-465).
      const recent = query.messages.filter((m) => m.held !== true).slice(-10);
      const observed = {
        returned: !!row,
        stampedTuneOut: row ? !!(row.metadata as { tuneOut?: unknown } | undefined)?.tuneOut : null,
        heldFlag: row ? (row.held ?? null) : null,
        inRetrievalsLastTen: recent.some(isHeldText),
      };
      console.log('PROBE-S4', JSON.stringify(observed));
      assert.deepEqual(observed, { returned: true, stampedTuneOut: true, heldFlag: null, inRetrievalsLastTen: true });
    } finally { await f.close(); }
  });

  it('S3: a restart keeps held messages, and the release after it carries them', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'r1', 'S3-BEFORE', AMBIENT);
      await settle(f);
      await f.framework.stop();
      await f.create();
      const afterBoot = {
        heldStored: stored(f).filter((m) => textOf(m).includes('S3-BEFORE')).map(held),
        stillTunedOut: !!internals(f).channelRegistry.getTuneOutState('editor', 'noisy'),
      };
      const cancelled = internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'probe');
      const dump = stored(f).find((m) => textOf(m).includes('<tuned-out-backlog'));
      const observed = { afterBoot, cancelled: cancelled.ok, dumpCarries: dump ? textOf(dump).includes('S3-BEFORE') : null };
      console.log('PROBE-S3', JSON.stringify(observed));
      assert.deepEqual(observed, { afterBoot: { heldStored: [true], stillTunedOut: true }, cancelled: true, dumpCarries: true });
    } finally { await f.close(); }
  });
});
