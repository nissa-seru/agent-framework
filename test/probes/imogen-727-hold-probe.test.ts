/**
 * A provider hold with nothing arriving, for the race fix that follows #727
 * (a batched wake's line decided when its turn starts), over the end-to-end
 * rig of test/batched-wake-line.test.ts (the wake-locus MCPL fixture,
 * addressed messages through a 300 ms debounce). One DM, newest; the first
 * attempt meets an organization-acceleration 429, and the hold's fresh start
 * compiles again. The test logs each request's tail on a PROBE line and
 * asserts only the rig's premises.
 *
 * Prediction, from the same probe run on this branch's working tree before
 * its review rounds: the first request ends with the DM and a `[routing]`
 * notice naming its channel, with no `[Gate: …]` line (the DM was newest at
 * the start); the fresh start finds that notice after the DM, so its request
 * ends DM, `[routing]`, `[Gate: 1 event matched] …`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MockMembrane, MockYieldingStream, createMockResponse } from '../helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/wake-locus-mcpl-server.mjs');
const RAW_DM = '1548000000000000001';
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
}
class HoldOnce extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (++this.n === 1) {
      const error = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429,
        message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
        rawError: { status: 429 }, rawRequest: request });
      return { isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
        provideToolResults() { throw new Error('no'); }, cancel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { yield { type: 'error', error } as StreamEvent; } } as unknown as YieldingStream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'hello back' }])]);
  }
}
describe('PROBE: a provider hold with nothing arriving', () => {
  it('prints the requests', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'probe-hold-'));
    const commandPath = join(tempDir, 'commands.txt'); writeFileSync(commandPath, '');
    const membrane = new HoldOnce();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: { config: { policies: [{ name: 'addressed', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'], tagsAny: ['chat:addressed'] }, behavior: { debounce: 300 } }], default: 'skip' } },
      mcplServers: [{ id: 'discord', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [],
    } as never);
    const fw = framework as unknown as { providerAccelerationDefaultCooldownMs: number; providerAccelerationJitterMs: number };
    fw.providerAccelerationDefaultCooldownMs = 1_000; fw.providerAccelerationJitterMs = 0;
    try {
      await framework.start();
      const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
      await waitFor(() => registry.listChannelsRaw().length >= 2, 'channels');
      appendFileSync(commandPath, `dm ev-h1 134 ${RAW_DM} are you there?\n`);
      await waitFor(() => membrane.calls.length >= 2, 'held attempt and fresh compile', 20_000);
      await new Promise((r) => setTimeout(r, 200));
      const tail = (i: number) => (membrane.calls[i] as unknown as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }).messages
        .slice(-3).map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b.text ?? '').slice(0, 90)).join(' | '));
      console.log('PROBE first request tail:', JSON.stringify(tail(0)));
      console.log('PROBE fresh start request tail:', JSON.stringify(tail(1)));
      assert.ok(true);
    } finally { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); }
  });
});
