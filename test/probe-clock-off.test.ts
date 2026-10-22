/**
 * PROBE (not for the repository): with AgentConfig.clock left out, does #685
 * send byte for byte what main sends? The same turns run in each tree with a
 * frozen Date.now: an event, a tool round with an event arriving during the
 * tool (injected mid-turn where the stream allows it), a silent heartbeat
 * tick, and a later event. Every request membrane is asked for, its
 * Anthropic wire body (captured by a local server), every injection and
 * every stored row go to $ON_VPS_EVIDENCE_DIR/clock-off/ (else the system's
 * temporary directory). Run it here, at #685's head 2439846e, and with this
 * file copied into its base 5daf3445, then `diff -r` the two clock-off/
 * directories: empty means the same bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnthropicAdapter, Membrane } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const OUT = join(process.env.ON_VPS_EVIDENCE_DIR ?? tmpdir(), 'clock-off');
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

async function wireBody(request: unknown): Promise<string> {
  let body: string | null = null;
  const server = createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => { body ??= data; res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'capture' } })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const membrane = new Membrane(new AnthropicAdapter({ apiKey: 'probe', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  try { await membrane.complete(request as never); } catch { /* capture answers 400 */ }
  server.close();
  return body ?? '';
}

test('CLOCK-OFF probe', async () => {
  const realNow = Date.now;
  Date.now = () => frozen++;
  const dir = mkdtempSync(join(tmpdir(), 'clock-off-'));
  const membrane = new MockMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), timeZone: 'UTC',
    agents: [{ name: 'assistant', model: 'claude-haiku-4-5', systemPrompt: 'test', proseRouting: 'locus', maxTokens: 4_000 }],
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
  const injections: unknown[] = [];
  let rows: any[] = [];
  try {
    await wake(event('first'), [{ type: 'text', text: 'ok' }]);
    frozen = Date.parse('2026-10-21T11:23:10Z');
    mod.during = () => { frozen = Date.parse('2026-10-21T11:42:10Z'); };
    await wake(event('second'), [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock], [{ type: 'text', text: 'done' }]);
    injections.push(membrane.lastStream?.receivedToolResultOptions ?? null);
    frozen = Date.parse('2026-10-21T11:51:10Z');
    await wake(silentTick(), [{ type: 'text', text: 'all quiet' }]);
    frozen = Date.parse('2026-10-22T00:01:10Z');
    await wake(event('next day'), [{ type: 'text', text: 'morning' }]);
    rows = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .map((m: any) => ({ participant: m.participant, content: m.content, metadata: m.metadata, timestamp: m.timestamp }));
  } finally {
    await framework.stop();
    Date.now = realNow;
  }
  writeFileSync(join(OUT, 'rows.json'), JSON.stringify(rows, null, 1));
  writeFileSync(join(OUT, 'injections.json'), JSON.stringify(injections, null, 1));
  writeFileSync(join(OUT, 'requests.json'), JSON.stringify(membrane.calls, null, 1));
  for (let i = 0; i < membrane.calls.length; i++) writeFileSync(join(OUT, `wire-${i}.json`), await wireBody(membrane.calls[i]));
  console.log(`CLOCK-OFF ${JSON.stringify({ calls: membrane.calls.length, rows: rows.length, clockRows: rows.filter((r: any) => r.metadata?.kind === 'clock').length })}`);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(membrane.calls.length >= 4, 'every wake reached the provider');
});
