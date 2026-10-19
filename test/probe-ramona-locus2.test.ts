/**
 * PROBE (Ramona-2416, reading #546 at 220f4cffe; not part of the change).
 * What a resident meets on turns with no delivery of their own, under each
 * speech.locus rule: a heartbeat's prose, a mail-woken turn's prose, a
 * channel_publish with no channelId, and the [routing] notice after boot and
 * after a restart. It logs what happened and asserts nothing.
 */
import { describe, it } from 'node:test';
import { fixture } from './helpers/coalescing-fixture.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { say } from './helpers/dendrite.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { MENTION, incoming, registerOpen } from './helpers/admission.js';

type F = Awaited<ReturnType<typeof fixture>>;
type Block = { type: string; text?: string; content?: unknown; toolUseId?: string; tool_use_id?: string; isError?: boolean };
type Msg = { participant: string; content: Block[]; metadata?: Record<string, unknown> };
type Trace = { type: string; agentName?: string; channelId?: string; reason?: string };

const win = (f: F): Msg[] => f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Msg[];
const textOf = (m: Msg) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' | ');

function script(f: F, ...responses: ReturnType<typeof say>[]) {
  f.membrane.responses.length = 0;
  (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
  for (const r of responses) f.membrane.pushResponse(r);
}

function heartbeat(f: F) {
  (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
    agentName: 'agent', reason: 'heartbeat', source: 'test', timestamp: Date.now(),
  });
}

function watch(f: F, traces: Trace[]) {
  f.framework.onTrace((t) => { traces.push(t as Trace); });
}

async function step(f: F, rule: string, label: string, traces: Trace[], run: () => Promise<void> | void) {
  const before = { msgs: win(f).length, traces: traces.length, published: f.published.length };
  await run();
  await f.framework.runUntilIdle();
  await new Promise((r) => setTimeout(r, 200));
  await f.framework.runUntilIdle();
  const p = `PROBE ${rule} ${label}`;
  const newTraces = traces.slice(before.traces);
  const started = newTraces.filter((t) => t.type === 'inference:started' && t.agentName === 'agent');
  console.log(`${p} TURNS ${started.length} LOCUS ${JSON.stringify(started.map((t) => t.channelId ?? null))}`);
  for (const m of win(f).slice(before.msgs)) {
    const kind = String(m.metadata?.kind ?? '');
    const text = textOf(m);
    if (kind === 'routing-notice' || text.includes('[routing]')) console.log(`${p} NOTICE [${kind}] ${text}`);
    if (text.includes('[send-undeliverable]')) console.log(`${p} MARKER [${kind}] ${text.slice(0, 400)}`);
    for (const b of m.content) {
      if (b.type === 'tool_result') console.log(`${p} TOOL-RESULT ${JSON.stringify(b).slice(0, 400)}`);
    }
  }
  const failed = newTraces.filter((t) => t.type === 'mcpl:speech-route-failed');
  console.log(`${p} ROUTE-FAILED ${failed.length} ${JSON.stringify(failed.map((t) => t.reason))}`);
  console.log(`${p} PUBLISHED ${JSON.stringify(f.published.slice(before.published)).slice(0, 600)}`);
}

for (const rule of ['delivery', 'latest-inbound'] as const) {
  describe(`PROBE under speech.locus '${rule}'`, () => {
    it(`PROBE ${rule}: turns with no delivery of their own`, { timeout: 120_000 }, async () => {
      const f = await fixture({ framework: { speech: { locus: rule } } as Partial<FrameworkConfig> });
      try {
        let traces: Trace[] = [];
        watch(f, traces);
        await registerOpen(f, 'work');

        await step(f, rule, '1-heartbeat-after-boot', traces, () => { script(f, say('hb one')); heartbeat(f); });
        await step(f, rule, '2-mention-in-work', traces, async () => {
          script(f, say('reply to the mention'));
          await incoming(f, 'work', 'w1', '@agent hello', MENTION);
        });
        await step(f, rule, '3-heartbeat-prose', traces, () => { script(f, say('hb two')); heartbeat(f); });
        await step(f, rule, '4-mail-woken-prose', traces, () => {
          script(f, say('answer to mail'));
          const sent = f.framework.sendAgentMessage('agent', 'agent', [{ type: 'text', text: 'a report' }]);
          console.log(`PROBE ${rule} 4-mail-woken-prose SENT ${JSON.stringify(sent)}`);
        });
        await step(f, rule, '5-heartbeat-publish-no-channelId', traces, () => {
          script(
            f,
            createMockResponse([{ type: 'tool_use', id: 'pub1', name: 'channel_publish', input: { content: 'via the tool' } }], 'tool_use'),
            say('after the publish'),
          );
          heartbeat(f);
        });
        await step(f, rule, '6-mention-in-work-again', traces, async () => {
          script(f, say('reply to the second mention'));
          await incoming(f, 'work', 'w2', '@agent again', MENTION);
        });

        await f.framework.stop();
        await f.create();
        traces = [];
        watch(f, traces);
        await step(f, rule, '7-heartbeat-after-restart', traces, () => { script(f, say('hb three')); heartbeat(f); });
        const notices = win(f).filter((m) => m.metadata?.kind === 'routing-notice').map(textOf);
        console.log(`PROBE ${rule} 7-heartbeat-after-restart LAST-NOTICE-IN-WINDOW ${notices.at(-1) ?? '(none)'}`);
      } finally { await f.close(); }
    });
  });
}
