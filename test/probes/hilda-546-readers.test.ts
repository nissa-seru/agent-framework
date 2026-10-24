/**
 * Probes for findings a review of #546's catch-up merge raised in
 * Dendrite's reader-fork code, which the merge doesn't change (run at
 * 83b66cae and at the merge's head):
 *
 * R13: after a cadence-triggered reader fork, do later cadence ticks with
 *      no new traffic derive more reader forks, with nothing held for them?
 * R14: when deliver_summary's attributed mail can't be created (the
 *      registry's holdMail throws), does the fork's final prose still
 *      reach the resident?
 *
 * Each logs PROBE-R lines; they assert only that the setup ran.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework, defaultReaderFraming } from '../../src/index.js';
import type { TraceEvent } from '../../src/index.js';
import { MockYieldingStream, createMockResponse } from '../helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

/** Routes by the reader's framing; each stream takes one queued response. */
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

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-readers-'));
  const commandPath = join(dir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new RoutedMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: {
      enabled: true, reader: 'forks', model: 'test-model',
      voice: 'You are reading for scout. Report briefly.',
      framing: (ctx) => defaultReaderFraming(ctx),
    },
    mcplServers: [{
      id: 'disc', command: process.execPath, args: [FIXTURE],
      env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [],
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const log: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { log.push(a.map(String).join(' ')); };
  await framework.start();
  const i = framework as unknown as {
    tuneOutCoordinator: TuneOutCoordinator;
    channelRegistry: { listChannelsRaw(): unknown[] };
    registry: { holdMail(...args: unknown[]): unknown };
  };
  await waitFor(() => i.channelRegistry.listChannelsRaw().length > 0, 'channel registration');
  const emit = (kind: 'ambient' | 'addressed', id: string, text: string): void => appendFileSync(commandPath, `${kind} ${id} ${text}\n`);
  const forks = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { agentName: string; trigger: string; held: number }>;
  const cleanup = async () => { console.error = orig; await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { framework, membrane, i, emit, forks, traces, log, cleanup };
}

describe('reader-fork probes', () => {
  it('PROBE R13: cadence forks after the traffic was read', { timeout: 150_000 }, async () => {
    const h = await boot();
    try {
      const entered = h.i.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 30, backlogCap: 5, maxWakes: 5 }, 'agent-tool');
      assert.ok(entered.ok);
      h.emit('ambient', 'a1', 'release chatter one');
      await waitFor(() => h.forks().length >= 1, 'the first cadence fork', 45_000);
      const firstAt = Date.now();
      // Two more cadence periods with no traffic at all.
      await sleep(65_000);
      const all = h.forks().map((f) => `${f.trigger}:held=${f.held}`);
      console.log(`# PROBE-R13 forks after one ambient message and ${Math.round((Date.now() - firstAt) / 1000)} s of silence: ${all.length} [${all.join(', ')}]`);
      console.log(`# PROBE-R13 reader requests made: ${h.membrane.calls.filter((c) => JSON.stringify(c.messages).includes('[Tune-out reader')).length}`);
    } finally { await h.cleanup(); }
  });

  type R14 = 'prose-only' | 'summary-ok' | 'summary-mail-fails';
  for (const mode of ['prose-only', 'summary-ok', 'summary-mail-fails'] as R14[]) {
    it(`PROBE R14 (${mode}): what of a reader fork's report reaches the resident`, { timeout: 90_000 }, async () => {
      const h = await boot();
      try {
        const entered = h.i.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 5, maxWakes: 5 }, 'agent-tool');
        assert.ok(entered.ok);
        const holdMail = h.i.registry.holdMail.bind(h.i.registry);
        let mailCalls = 0;
        let reportedAtMail: boolean | undefined;
        h.i.registry.holdMail = (...args: unknown[]) => {
          mailCalls++;
          const fork = h.forks()[0]?.agentName;
          if (fork) reportedAtMail = h.i.tuneOutCoordinator.readerReported(fork);
          if (mode === 'summary-mail-fails' && mailCalls === 1) throw new Error('zz durable mail write failed');
          return holdMail(...args);
        };
        const summary = createMockResponse([{ type: 'tool_use', id: 'call-report', name: 'deliver_summary', input: { text: 'zz-summary', channelId: CHANNEL } }], 'tool_use');
        const prose = createMockResponse([{ type: 'text', text: 'zz-prose-fallback' }]);
        if (mode === 'prose-only') h.membrane.push('reader', prose);
        else h.membrane.push('reader', summary, prose);
        h.emit('addressed', 'm1', 'hey scout, quick question');
        await waitFor(() => h.forks().length >= 1, 'a reader fork', 30_000);
        const fork = h.forks()[0]!.agentName;
        let reportedAtEnd: boolean | undefined;
        const ended = await waitFor(() => {
          if (h.framework.getAgentRecord(fork)?.ended !== undefined) return true;
          reportedAtEnd = h.i.tuneOutCoordinator.readerReported(fork);
          return false;
        }, 'the fork ends', 30_000).then(() => true, () => false);
        await sleep(3_000);
        const readerStream = h.membrane.streams.find((x) => x.who === 'reader')?.stream;
        const scout = h.framework.getAgent('scout')!.getContextManager().getAllMessages() as unknown as Array<{ participant: string; content: Array<{ type: string; text?: string }>; metadata?: { kind?: string } }>;
        const withText = (t: string) => scout.filter((m) => m.content.some((b) => (b.text ?? '').includes(t))).map((m) => `${m.participant}/${m.metadata?.kind ?? '-'}`);
        console.log(`# PROBE-R14 ${mode}: fork ended: ${ended} (${h.framework.getAgentRecord(fork)?.ended?.reason}); holdMail calls: ${mailCalls}; readerReported when holdMail was called: ${reportedAtMail}; last seen before the end: ${reportedAtEnd}`);
        console.log(`# PROBE-R14 ${mode}: tool results: ${JSON.stringify(readerStream?.receivedToolResults ?? null).slice(0, 300)}`);
        console.log(`# PROBE-R14 ${mode}: in scout's store: zz-summary ${JSON.stringify(withText('zz-summary'))}, zz-prose-fallback ${JSON.stringify(withText('zz-prose-fallback'))}; prose delivery traced: ${h.traces.some((t) => t.type === 'tune-out:reader-prose-delivered')}`);
      } finally { await h.cleanup(); }
    });
  }
});
