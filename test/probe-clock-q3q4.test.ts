/**
 * PROBE (not for the repository), #685 at 2439846e: what an agent reads from a clock in a conversation
 * fork and beside held drafts, and the quiesce and shared-slot guards taken
 * through the real write paths. Date.now is frozen per step and advances
 * 1 ms per read. Each test writes what it saw to
 * $ON_VPS_EVIDENCE_DIR/clock-q3q4/<name>.json and prints a PROBE- line;
 * each asserts that some clock row was written, so a pass can't come from a
 * clock that never fired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';

const OUT = join(process.env.ON_VPS_EVIDENCE_DIR ?? tmpdir(), 'clock-q3q4');
mkdirSync(OUT, { recursive: true });

/** A stream asked for with nothing queued answers a plain reply, so a turn
 *  the probe didn't plan for (a second resident's, say) ends instead of
 *  hanging the test. */
class DefaultingMembrane extends MockMembrane {
  defaults = 0;
  override streamYielding(request: any, options?: unknown) {
    if ((this as any).responseIndex >= this.responses.length) {
      this.defaults++;
      this.pushResponse(createMockResponse([{ type: 'text', text: '(default reply)' }]));
    }
    return super.streamYielding(request, options);
  }
}

class ToolModule implements Module {
  readonly name = 'tools';
  during: (() => void) | null = null;
  async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); }
  async stop() {}
  async onProcess() { return {}; }
  async onAgentSpeech() {}
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during; this.during = null; during?.();
    return { success: true, data: { ok: true } };
  }
}

let seq = 0;
let frozen = Date.parse('2026-10-21T10:45:10Z');
const at = (s: string) => { frozen = Date.parse(s); };
const iso = () => new Date(frozen).toISOString();
const pushEvent = (text: string) => {
  const n = ++seq;
  return { type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes', eventId: `ev-${n}`,
    content: [{ type: 'text', text }], timestamp: iso(), inferenceId: `inf-ev-${n}`, triggerInference: true };
};
const dm = (text: string) => ({
  type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:D1', messageId: `m-${++seq}`,
  author: { id: 'U1', name: 'alice' }, content: [{ type: 'text', text }], timestamp: iso(),
  metadata: { mentioned: false, channel_type: 'im' }, triggerInference: true,
}) as unknown as ProcessEvent;

async function makeFramework(agents: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clock-q3q4-'));
  const membrane = new DefaultingMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), timeZone: 'UTC',
    agents: agents.map((a) => ({ model: 'claude-haiku-4-5', systemPrompt: 'test', proseRouting: 'locus', maxTokens: 4_000, clock: { intervalMinutes: 10 }, ...a })),
    modules: [mod], ...extra,
  } as never);
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
    startTyping: () => {}, stopTyping: () => {}, getChannelTools: () => [], getDescriptor: () => undefined,
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  const queue = (...responses: ContentBlock[][]) => {
    for (const content of responses) membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
  };
  const wake = async (ev: unknown, ...responses: ContentBlock[][]) => {
    queue(...responses);
    (framework as any).handleMcplPushEvent(ev);
    await framework.runUntilIdle();
  };
  return { dir, membrane, mod, framework, wake, queue };
}
const textOf = (content: any[]) => content.map((b: any) => b.text ?? `[${b.type}]`).join('');
const rowsOf = (framework: AgentFramework, name: string) => framework.getAgent(name)!.getContextManager().getAllMessages()
  .map((m: any) => ({ participant: m.participant, text: textOf(m.content), kind: m.metadata?.kind ?? null, at: m.timestamp }));
const requestOf = (call: any) => call.messages.map((m: any) => `${m.participant}: ${textOf(m.content)}`);
const prefixes = (calls: any[]) => calls.slice(1).map((c, i) => {
  const prev = calls[i].messages.map((m: any) => JSON.stringify(m));
  const next = c.messages.map((m: any) => JSON.stringify(m));
  let k = 0; while (k < prev.length && prev[k] === next[k]) k++;
  return { request: i + 1, prevLength: prev.length, matched: k, prefix: k === prev.length };
});
const clocks = (rows: Array<{ kind: string | null; text: string }>) => rows.filter((r) => r.kind === 'clock').map((r) => r.text);
const clockTexts = (lines: string[]) => lines.filter((l) => l.includes('Clock: '));

test('PROBE Q3a: a conversation fork spawned long after its template\'s last clock', async () => {
  const realNow = Date.now; Date.now = () => frozen++;
  const x = await makeFramework([{ name: 'trunk', systemPrompt: 'You are the trunk.' }], { conversations: { templateAgent: 'trunk' } });
  const fork = forkAgentName('conversation', 'srv', 'slack:D1', 1);
  const out: Record<string, unknown> = { fork };
  try {
    at('2026-10-21T10:41:10Z');
    await x.wake(pushEvent('warm'), [{ type: 'text', text: 'ok' }]);
    out.trunkAfterWarm = rowsOf(x.framework, 'trunk');
    // 86 minutes later, a DM spawns the channel's fork, seeded from the trunk.
    at('2026-10-21T12:07:10Z');
    x.queue([{ type: 'text', text: 'hi alice' }]);
    const before = x.membrane.calls.length;
    x.framework.pushEvent(dm('hello'));
    await x.framework.runUntilIdle();
    assert.ok(x.framework.getAgent(fork), 'the fork was spawned');
    out.forkFirstRequest = x.membrane.calls.slice(before).map(requestOf);
    out.forkRowsAfterFirst = rowsOf(x.framework, fork);
    // The trunk, at the same minute: what its own next event reads.
    at('2026-10-21T12:07:40Z');
    const trunkBefore = x.membrane.calls.length;
    await x.wake(pushEvent('trunk now'), [{ type: 'text', text: 'ok now' }]);
    out.trunkRequestSameMinute = x.membrane.calls.slice(trunkBefore).map(requestOf);
    // The fork's next DM, after the next boundary.
    at('2026-10-21T12:12:10Z');
    x.queue([{ type: 'text', text: 'hi again' }]);
    const before2 = x.membrane.calls.length;
    x.framework.pushEvent(dm('again'));
    await x.framework.runUntilIdle();
    out.forkSecondRequest = x.membrane.calls.slice(before2).map(requestOf);
    out.forkRows = rowsOf(x.framework, fork);
    out.trunkRows = rowsOf(x.framework, 'trunk');
    out.defaults = x.membrane.defaults;
  } finally { await x.framework.stop(); Date.now = realNow; }
  writeFileSync(join(OUT, 'fork.json'), JSON.stringify(out, null, 1));
  const summary = {
    trunkClocks: clocks(out.trunkRows as any), forkClockRows: clocks(out.forkRows as any),
    forkFirstRequestClockTexts: (out.forkFirstRequest as string[][]).map(clockTexts),
    trunkSameMinuteClockTexts: (out.trunkRequestSameMinute as string[][]).map(clockTexts),
    forkSecondRequestClockTexts: (out.forkSecondRequest as string[][]).map(clockTexts),
    forkRowKinds: (out.forkRows as any[]).map((r) => `${r.participant}:${r.kind ?? '-'}:${r.text.slice(0, 40)}`),
    defaults: out.defaults,
  };
  console.log(`# PROBE-Q3a ${JSON.stringify(summary)}`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(clocks(out.trunkRows as any).length > 0, 'a clock row was written');
});

test('PROBE Q3b: a clock beside held drafts (explicit routing, a tool round across a boundary)', async () => {
  const realNow = Date.now; Date.now = () => frozen++;
  const x = await makeFramework([{ name: 'assistant', proseRouting: 'explicit' }]);
  const out: Record<string, unknown> = {};
  try {
    at('2026-10-21T10:41:10Z');
    await x.wake(pushEvent('warm'), [{ type: 'text', text: 'warm words' }]);
    at('2026-10-21T10:48:10Z');
    x.mod.during = () => { at('2026-10-21T10:52:10Z'); };
    await x.wake(pushEvent('go'),
      [{ type: 'text', text: 'thinking aloud' }, { type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
      [{ type: 'text', text: 'done aloud' }]);
    out.injections = x.membrane.lastStream?.receivedToolResultOptions ?? null;
    at('2026-10-21T11:01:10Z');
    await x.wake(pushEvent('next'), [{ type: 'text', text: 'next words' }]);
    out.requests = x.membrane.calls.map(requestOf);
    out.rows = rowsOf(x.framework, 'assistant');
    out.defaults = x.membrane.defaults;
  } finally { await x.framework.stop(); Date.now = realNow; }
  writeFileSync(join(OUT, 'drafts.json'), JSON.stringify(out, null, 1));
  const rows = out.rows as any[];
  console.log(`# PROBE-Q3b ${JSON.stringify({
    rows: rows.map((r) => `${r.participant}:${r.kind ?? '-'}:${r.text.slice(0, 60)}`),
    prefixes: prefixes(x.membrane.calls), defaults: out.defaults })}`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(clocks(rows).length > 0, 'a clock row was written');
});

test('PROBE Q4a: quiesce, through the write path', async () => {
  const realNow = Date.now; Date.now = () => frozen++;
  const x = await makeFramework([{ name: 'assistant' }]);
  const out: Record<string, unknown> = {};
  try {
    at('2026-10-21T10:41:10Z');
    await x.wake(pushEvent('warm'), [{ type: 'text', text: 'ok' }]);
    at('2026-10-21T10:55:10Z');
    await x.framework.quiesce({ reason: 'probe' });
    (x.framework as any).handleMcplPushEvent(pushEvent('during quiesce'));
    await new Promise((r) => setTimeout(r, 50));
    out.rowsWhileQuiesced = rowsOf(x.framework, 'assistant');
    out.deferredWhileQuiesced = ((x.framework as any).deferredMessages as any[]).map((m) => textOf(m.content));
    at('2026-10-21T10:56:10Z');
    x.queue([{ type: 'text', text: 'after resume' }]);
    await x.framework.resume();
    await x.framework.runUntilIdle();
    out.rows = rowsOf(x.framework, 'assistant');
    out.requests = x.membrane.calls.map(requestOf);
    out.defaults = x.membrane.defaults;
  } finally { await x.framework.stop(); Date.now = realNow; }
  writeFileSync(join(OUT, 'quiesce.json'), JSON.stringify(out, null, 1));
  console.log(`# PROBE-Q4a ${JSON.stringify({
    clocksWhileQuiesced: clocks(out.rowsWhileQuiesced as any), deferredWhileQuiesced: out.deferredWhileQuiesced,
    rows: (out.rows as any[]).map((r) => `${r.participant}:${r.kind ?? '-'}:${r.text.slice(0, 50)}`),
    prefixes: prefixes(x.membrane.calls), defaults: out.defaults })}`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(clocks(out.rows as any).length > 1, 'a clock row was written after resume');
});

test('PROBE Q4b: two residents in the shared slot, a write for one while the other\'s turn is alive', async () => {
  const realNow = Date.now; Date.now = () => frozen++;
  const x = await makeFramework([{ name: 'assistant' }, { name: 'second' }]);
  const out: Record<string, unknown> = {};
  const writeFor = (name: string, text: string) =>
    (x.framework as any).addMessage('user', [{ type: 'text', text }], {}, { forAgent: name });
  try {
    at('2026-10-21T10:41:10Z');
    await x.wake(pushEvent('warm'), [{ type: 'text', text: 'ok' }]);
    out.sharedSlot = [...((x.framework as any).sharedSlotAgents as Set<any>)].map((a) => a.name);
    at('2026-10-21T11:05:10Z');
    x.mod.during = () => {
      at('2026-10-21T11:16:10Z');
      out.turnAliveAssistant = (x.framework as any).turnAlive(x.framework.getAgent('assistant'));
      out.turnAliveSecond = (x.framework as any).turnAlive(x.framework.getAgent('second'));
      out.writeForSecondDuringTurn = writeFor('second', 'for second, during the turn');
      out.assistantRowsDuringTurn = rowsOf(x.framework, 'assistant');
    };
    await x.wake(pushEvent('go'), [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock], [{ type: 'text', text: 'done' }]);
    out.injections = x.membrane.lastStream?.receivedToolResultOptions ?? null;
    at('2026-10-21T11:31:10Z');
    out.writeForSecondAfter = writeFor('second', 'for second, after the turn');
    await x.framework.runUntilIdle();
    out.assistantRows = rowsOf(x.framework, 'assistant');
    out.secondRows = rowsOf(x.framework, 'second');
    out.requests = x.membrane.calls.map(requestOf);
    out.defaults = x.membrane.defaults;
  } finally { await x.framework.stop(); Date.now = realNow; }
  writeFileSync(join(OUT, 'shared-slot.json'), JSON.stringify(out, null, 1));
  const assistantDuring = out.assistantRowsDuringTurn as any[] | undefined;
  console.log(`# PROBE-Q4b ${JSON.stringify({
    sharedSlot: out.sharedSlot, turnAliveAssistant: out.turnAliveAssistant, turnAliveSecond: out.turnAliveSecond,
    clocksDuringTurn: assistantDuring ? clocks(assistantDuring) : null,
    assistantRows: (out.assistantRows as any[]).map((r) => `${r.participant}:${r.kind ?? '-'}:${r.text.slice(0, 50)}`),
    secondRows: (out.secondRows as any[]).map((r) => `${r.participant}:${r.kind ?? '-'}:${r.text.slice(0, 50)}`),
    prefixes: prefixes(x.membrane.calls), defaults: out.defaults })}`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(clocks(out.assistantRows as any).length > 0, 'a clock row was written');
});
