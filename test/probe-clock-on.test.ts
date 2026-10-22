/**
 * PROBE (not for the repository): with AgentConfig.clock on, at #685's head
 * 2439846e, one resident takes an event, a tool round across a boundary, a
 * silent heartbeat tick and a later event. It writes the clock rows, every
 * stored row, the injections, and for each request after the first whether
 * the request before it is a prefix of it, message for message, to
 * $ON_VPS_EVIDENCE_DIR/clock-on/one-resident.json (else the system's
 * temporary directory).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const OUT = join(process.env.ON_VPS_EVIDENCE_DIR ?? tmpdir(), 'clock-on');
mkdirSync(OUT, { recursive: true });

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
const iso = () => new Date(frozen).toISOString();
const event = (text: string) => {
  const n = ++seq;
  return { type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes', eventId: `ev-${n}`,
    content: [{ type: 'text', text }], timestamp: iso(), inferenceId: `inf-ev-${n}`, triggerInference: true };
};
const silentTick = () => {
  const n = ++seq;
  return { type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat', eventId: `hb-${n}`, content: [],
    timestamp: iso(), origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-21 10:51:00 UTC' },
    inferenceId: `inf-hb-${n}`, triggerInference: true };
};



async function makeFramework(agents: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'clock-on-'));
  const membrane = new MockMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), timeZone: 'UTC',
    agents: agents.map((a) => ({ model: 'claude-haiku-4-5', systemPrompt: 'test', proseRouting: 'locus', maxTokens: 4_000, clock: { intervalMinutes: 10 }, ...a })),
    modules: [mod],
  } as never);
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
    startTyping: () => {}, stopTyping: () => {}, getChannelTools: () => [], getDescriptor: () => undefined,
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  const wake = async (ev: unknown, ...responses: ContentBlock[][]) => {
    for (const content of responses) membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
    (framework as any).handleMcplPushEvent(ev);
    await framework.runUntilIdle();
  };
  return { dir, membrane, mod, framework, wake };
}
const rowsOf = (framework: AgentFramework, name: string) => framework.getAgent(name)!.getContextManager().getAllMessages()
  .map((m: any) => ({ participant: m.participant, text: m.content.map((b: any) => b.text ?? `[${b.type}]`).join(''), kind: m.metadata?.kind ?? null }));
/** For each request after the first: is the request before it a prefix of it, message for message? */
const prefixes = (calls: any[]) => calls.slice(1).map((c, i) => {
  const prev = calls[i].messages.map((m: any) => JSON.stringify(m));
  const next = c.messages.map((m: any) => JSON.stringify(m));
  let k = 0; while (k < prev.length && prev[k] === next[k]) k++;
  return { request: i + 1, prevLength: prev.length, matched: k, prefix: k === prev.length };
});

test('CLOCK-ON probe: one resident, the cache prefix across every request', async () => {
  const realNow = Date.now; Date.now = () => frozen++;
  const x = await makeFramework([{ name: 'assistant' }]);
  let injections: unknown = null;
  let rows: ReturnType<typeof rowsOf> = [];
  try {
    frozen = Date.parse('2026-10-21T10:41:10Z');
    await x.wake(event('warm'), [{ type: 'text', text: 'ok' }]);
    frozen = Date.parse('2026-10-21T10:48:10Z');
    x.mod.during = () => { frozen = Date.parse('2026-10-21T10:52:10Z'); };
    await x.wake(event('go'), [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock], [{ type: 'text', text: 'done' }]);
    injections = x.membrane.lastStream?.receivedToolResultOptions ?? null;
    frozen = Date.parse('2026-10-21T11:23:10Z');
    await x.wake(silentTick(), [{ type: 'text', text: 'all quiet' }]);
    frozen = Date.parse('2026-10-21T11:31:10Z');
    await x.wake(event('later'), [{ type: 'text', text: 'ok later' }]);
    rows = rowsOf(x.framework, 'assistant');
  } finally { await x.framework.stop(); Date.now = realNow; }
  const result = { clockRows: rows.filter((r) => r.kind === 'clock').map((r) => r.text), prefixes: prefixes(x.membrane.calls), rows, injections };
  writeFileSync(join(OUT, 'one-resident.json'), JSON.stringify(result, null, 1));
  console.log(`CLOCK-ON one-resident ${JSON.stringify({ clockRows: result.clockRows, prefixes: result.prefixes })}`);
  rmSync(x.dir, { recursive: true, force: true });
  assert.ok(result.clockRows.length > 0, 'a clock row was written');
});
