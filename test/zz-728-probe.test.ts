/**
 * A probe of agent-framework #728 at d6488d12, by Hilda-2681, for the house's
 * review of it. Not part of the PR. One ephemeral run (as a host's subagent
 * is) through the framework's real turn path, against a membrane that fails
 * its turn calls:
 * - a 429 stating a 90 s wait: how long until the run's turn ends or retries;
 * - 529s throughout: the traces naming the run, with their times, so the
 *   silences between them show.
 * Observed values are logged as PROBE JSON.
 */
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class FailingMembrane extends MockMembrane {
  constructor(private readonly failure: () => Error | undefined) { super(); }
  sends: number[] = [];
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    this.sends.push(Date.now());
    const failure = this.failure();
    if (failure) return new ErrorStream(failure);
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-answer' }])]);
  }
}

async function run(failure: () => Error | undefined, watchMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'zz-728-'));
  const membrane = new FailingMembrane(failure);
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'a', model: 'zz-model', systemPrompt: 'zz-a' }], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const t0 = Date.now();
  const traces: Array<{ atS: number; type: string }> = [];
  fw.onTrace((event) => {
    if ((event as { agentName?: string }).agentName === 'zz-run') traces.push({ atS: (Date.now() - t0) / 1000, type: event.type });
  });
  const created = await fw.createEphemeralAgent({ name: 'zz-run', model: 'zz-model', systemPrompt: 'zz-run' });
  created.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  let outcome: string | undefined;
  const settled = fw.runEphemeralToCompletion(created.agent, created.contextManager).then(
    () => { outcome = `completed at ${(Date.now() - t0) / 1000} s`; },
    (e: Error) => { outcome = `ended at ${(Date.now() - t0) / 1000} s: ${e.message.slice(0, 160)}`; });
  void fw.runUntilIdle().catch(() => {});
  await Promise.race([settled, new Promise((r) => setTimeout(r, watchMs))]);
  let longestSilenceS = 0;
  const times = [...traces.map((t) => t.atS), (Date.now() - t0) / 1000];
  for (let i = 1; i < times.length; i++) longestSilenceS = Math.max(longestSilenceS, times[i]! - times[i - 1]!);
  const result = { outcome: outcome ?? `still running at ${watchMs / 1000} s`, sendsAtS: membrane.sends.map((s) => (s - t0) / 1000),
    longestSilenceS, traces: traces.filter((t) => !t.type.startsWith('inference:tokens')) };
  await fw.stop();
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('PROBE-A: an ephemeral run whose call meets a 429 stating 90 s', async () => {
  let first = true;
  const r = await run(() => {
    if (!first) return undefined;
    first = false;
    return new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 90_000, message: 'zz rate limited', rawError: {} });
  }, 20_000);
  console.log(`# PROBE-A ${JSON.stringify(r)}`);
});

test('PROBE-B: an ephemeral run whose calls all meet a 529', async () => {
  const r = await run(() => new MembraneError({ type: 'server', retryable: true, httpStatus: 529, message: 'zz overloaded_error: Overloaded', rawError: {} }), 420_000);
  console.log(`# PROBE-B ${JSON.stringify(r)}`);
});
