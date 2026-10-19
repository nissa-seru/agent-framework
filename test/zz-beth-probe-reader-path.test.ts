/**
 * Probe (Beth-2389, house reader of #546), not part of the PR: the tune-out reader-fork path, run end to end on
 * the composed rig (chronicle #40, context-manager #238), with the resident mid-way through ONE tool call when
 * the reader fork is derived. It prints, as PROBE lines:
 *  1. what the reader fork is told about the resident's call in flight (the pending round's tool_result);
 *  2. whether the fork can call one of the resident's own module tools (`probe--echo`), and as whom;
 *  3. how many tool rounds the fork runs when its model keeps calling a tool (no stop is scripted short of K).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent, Module, ModuleContext, ToolDefinition, ToolCall, ToolResult, ProcessEvent, ProcessState, EventResponse } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const K = Number(process.env.PROBE_ROUNDS ?? 60);

class EchoModule implements Module {
  readonly name = 'probe';
  readonly callers: string[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.callers.push(String(call.callerAgentName));
    return { success: true, data: { echoed: (call.input as { n?: number }).n ?? null } };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  private queues = { resident: [] as NormalizedResponse[], reader: [] as NormalizedResponse[] };
  push(who: 'resident' | 'reader', ...responses: NormalizedResponse[]): void { this.queues[who].push(...responses); }
  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const who = JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'resident';
    return new MockYieldingStream(this.queues[who].splice(0));
  }
  async complete(): Promise<NormalizedResponse> { return createMockResponse([{ type: 'text', text: 'ok' }]); }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('probe: the reader-fork path with the resident in one tool call', () => {
  let tempDir: string; let commandPath: string; let framework: AgentFramework;
  const membrane = new RoutedMembrane(); const gates = new GateModule(); const echo = new EchoModule();
  const traces: TraceEvent[] = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'beth-reader-path-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'You are reading for scout.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [gates, echo],
    });
    framework.onTrace((event) => traces.push(event));
    await framework.start();
    const reg = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } | null }).channelRegistry;
    await waitFor(() => (reg?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
  });

  after(async () => {
    gates.release('g-scout');
    try { await framework.stop(); } catch { /* stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const emit = (kind: 'ambient' | 'addressed', id: string, text: string): void => { appendFileSync(commandPath, `${kind} ${id} ${text}\n`); };

  it('derives a reader fork while scout is inside one tool call', async () => {
    // scout wakes and blocks inside ONE call of its own (test--wait), unrelated to any fork.
    membrane.push('resident', waitCall('g-scout'), say('scout done'));
    emit('addressed', 'm0', 'scout, please run the long job');
    await waitFor(() => gates.entered.has('g-scout'), 'scout blocks in test--wait');

    const coordinator = (framework as unknown as { tuneOutCoordinator: TuneOutCoordinator }).tuneOutCoordinator;
    assert.ok(coordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 5, maxWakes: 3 }, 'agent-tool').ok);

    // The reader's model: K calls of scout's own module tool, then the report, then prose.
    const rounds: NormalizedResponse[] = [];
    for (let k = 0; k < K; k++) {
      rounds.push(createMockResponse([{ type: 'tool_use', id: `call-echo-${k}`, name: 'probe--echo', input: { n: k } }], 'tool_use'));
    }
    rounds.push(createMockResponse([{ type: 'tool_use', id: 'call-report', name: 'deliver_summary', input: { text: 'one question for you', channelId: CHANNEL } }], 'tool_use'));
    rounds.push(say('reported'));
    membrane.push('reader', ...rounds);
    membrane.push('resident', say('thanks'));
    emit('ambient', 'a1', 'release chatter');
    emit('addressed', 'm1', 'hey scout, quick question');

    const forkTrace = () => traces.find((t) => t.type === 'tune-out:reader-fork') as (TraceEvent & { agentName: string }) | undefined;
    await waitFor(() => !!forkTrace(), 'a reader fork is derived');
    const fork = forkTrace()!.agentName;
    await waitFor(() => !!framework.getAgentRecord(fork)?.ended, 'the reader fork ends', 60_000);
    const record = framework.getAgentRecord(fork)!;

    // 1. What the fork was told about scout's call in flight.
    const first = membrane.calls.find((c) => JSON.stringify(c.messages).includes('[Tune-out reader'))!;
    const results = first.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []) as unknown as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'tool_result');
    const forScout = results.find((b) => b.toolUseId === 'call-g-scout');
    // scout's gate stays closed until after(), so scout is still inside its call when the fork is derived.
    console.log('PROBE ' + JSON.stringify({
      part: 1, fork,
      pendingRoundInForkRequest: !!forScout,
      toolResultForScoutsCall: forScout ? (typeof forScout.content === 'string' ? forScout.content : JSON.stringify(forScout.content)) : null,
    }));
    // 2. Whether the fork could call scout's own module tool, and under which agent name it ran.
    const forkCalls = echo.callers.filter((c) => c === fork).length;
    console.log('PROBE ' + JSON.stringify({ part: 2, echoCallsByFork: forkCalls, echoCallers: [...new Set(echo.callers)] }));
    // 3. How far the fork ran: every scripted round (part 2's count), with no bound short of the script. The mock
    // stream answers a whole activation from one queue, so its stream count says nothing about rounds.
    console.log('PROBE ' + JSON.stringify({ part: 3, scriptedEchoRounds: K, echoRoundsRun: forkCalls, ended: record.ended, lifetime: record.lifetime, activation: record.activation ?? null }));
  });
});
