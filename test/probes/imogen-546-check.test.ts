/**
 * Probes of the fixes for #546's findings 2 and 3 at 6ba5f166, by
 * Imogen-2490. Not part of any PR. Each test
 * asserts what I predicted by reading before any run, so a pass shows the
 * prediction held; observed values are logged on IMOGEN- lines.
 *
 * K. Finding 3's order. A held result's release is written to the registry's
 *    recovery file (fsynced as written) when its message enters the
 *    recipient's store, whose write reaches disk only at the next
 *    store.sync(). Predicted at 6ba5f166: a process killed (SIGKILL) right
 *    after deliverAgentResult delivers restarts with the result in neither
 *    the recipient's window nor the held mail: lost. Predicted at be26b1af
 *    (control, both writes the store's): the restart finds it held and
 *    delivers it, once.
 * M. Finding 2, a fact-after write failing. deliverAgentResult holds the
 *    result durably, then attempts delivery; with the recipient gone, the
 *    `recipient-gone` mark is a second registry write. Predicted: when that
 *    write fails, deliverAgentResult throws though the result is held, a
 *    caller that retries holds it a second time, and an adoption delivers
 *    both.
 * R. Finding 2, a release's write failing (added after M's first run, on
 *    the same reading): with the recipient live, the result lands, and the
 *    release at the landing is a registry write. Predicted: when it fails,
 *    deliverAgentResult throws with the result already in the window, and a
 *    retry delivers it twice.
 * T. Finding 2, a stop's write failing (added on a reading of
 *    registry.end, which changes memory before persist and doesn't put it
 *    back). Predicted: stopAgent throws, the registry records the agent
 *    ended while it keeps running, and a second stop is refused as "not a
 *    registered agent".
 * S. Finding 2, a failed sync. Predicted: deliverAgentResult throws on a
 *    failed sync with the result still held; a caller that retries
 *    delivers the second hold now, and the first is delivered again at the
 *    next boot.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, workerSpec } from '../../src/index.js';
import type { AgentSpec } from '../../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from '../helpers/dendrite.js';

const here = dirname(fileURLToPath(import.meta.url));
const textOf = (content: ContentBlock[]) => content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
const rowsWith = (framework: AgentFramework, agent: string, needle: string) =>
  framework.getAgent(agent)!.getContextManager().getAllMessages().filter((m) => textOf(m.content).includes(needle)).length;

describe('probes K, M, R, S and T: findings 2 and 3 at 6ba5f166', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'imogen-546-check-'));
    membrane = new RoutedMembrane();
    frameworks = [];
  });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) {
      try { await framework.stop(); } catch { /* already stopped */ }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const storePath = () => join(tempDir, 'store.chronicle');
  async function boot(gates = new GateModule()): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: storePath(),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [gates],
      syncIntervalMs: 0,
    });
    frameworks.push(framework);
    return framework;
  }
  async function startBlocked(framework: AgentFramework, gates: GateModule, name: string, gate: string, spec: Omit<AgentSpec, 'name'>) {
    membrane.script(name, waitCall(gate), say(`${name} done`));
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' }, spec);
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const settled = framework.runEphemeralToCompletion(agent, contextManager).then(
      (value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await until(() => gates.entered.has(gate), `${name} to block on ${gate}`);
    return { settled };
  }

  it('K: a process killed after a delivered result restarts without it (6ba5f166) / with it once (be26b1af)', async () => {
    // The child: boot, finish a job whose result goes to mira, deliver it, die before any sync.
    const dist = join(here, '..', '..');
    const child = join(tempDir, 'child.mjs');
    writeFileSync(child, `
      import { AgentFramework, workerSpec } from ${JSON.stringify(pathToFileURL(join(dist, 'src', 'index.js')).href)};
      import { RoutedMembrane, say } from ${JSON.stringify(pathToFileURL(join(dist, 'test', 'helpers', 'dendrite.js')).href)};
      const membrane = new RoutedMembrane();
      const framework = await AgentFramework.create({
        storePath: ${JSON.stringify(storePath())},
        membrane: membrane.asMembrane(),
        agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
        modules: [],
        syncIntervalMs: 0,
      });
      framework.start();
      membrane.script('job', say('job done'));
      const { agent, contextManager } = await framework.createEphemeralAgent(
        { name: 'job', model: 'test-model', systemPrompt: 'Do the task.' },
        workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
      contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      await framework.runEphemeralToCompletion(agent, contextManager);
      const delivery = framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-K' }]);
      const rows = framework.getAgent('mira').getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('RESULT-K')).length;
      process.stdout.write(JSON.stringify({ delivered: delivery.delivered, rows, held: framework.listHeldMail().length }) + '\\n');
      process.kill(process.pid, 'SIGKILL');
    `);
    const ran = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 60_000 });
    const beforeKill = JSON.parse((ran.stdout.trim().split('\n').pop() || '{}')) as Record<string, unknown>;

    const second = await AgentFramework.create({
      storePath: storePath(),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
      modules: [],
      syncIntervalMs: 0,
    });
    frameworks.push(second);
    const afterRestart = { rows: rowsWith(second, 'mira', 'RESULT-K'), held: second.listHeldMail().length };
    const observed = { signal: ran.signal, beforeKill, afterRestart, stderrTail: ran.stderr.split('\n').filter(Boolean).slice(-3) };
    console.log('IMOGEN-K', JSON.stringify(observed));
    assert.equal(ran.signal, 'SIGKILL');
    assert.deepEqual(beforeKill, { delivered: true, rows: 1, held: 0 }, 'delivered and released before the kill');
    assert.deepEqual(afterRestart, { rows: 0, held: 0 }, 'predicted at 6ba5f166: the result is lost');
  });

  it('M: a recipient-gone mark whose write fails makes deliverAgentResult throw; a retry holds it twice; both outlive a restart', async () => {
    const gates = new GateModule();
    const framework = await boot(gates);
    framework.start();
    await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(framework, gates, 'job', 'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }));
    framework.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok);

    const internals = framework as unknown as { persistAgentRegistry(snapshot: { mail: Array<{ heldBecause?: string }> }): void };
    const original = internals.persistAgentRegistry.bind(framework);
    internals.persistAgentRegistry = (snapshot) => {
      if (snapshot.mail.some((m) => m.heldBecause === 'recipient-gone')) throw new Error('EIO: simulated write failure');
      original(snapshot);
    };
    let threw: string | null = null;
    try {
      framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-M' }]);
    } catch (error) {
      threw = String(error).slice(0, 160);
    } finally {
      internals.persistAgentRegistry = original;
    }
    const heldAfterThrow = framework.listHeldMail().length;
    const retry = framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-M' }]);
    const heldAfterRetry = framework.listHeldMail().length;
    await framework.stop();
    const second = await boot();
    const heldAfterRestart = second.listHeldMail().map((m) => [m.from.agent, m.to, m.heldBecause]);
    const observed = { threw, heldAfterThrow, retryDelivered: retry.delivered, heldAfterRetry, heldAfterRestart };
    console.log('IMOGEN-M', JSON.stringify(observed));
    assert.ok(threw, 'predicted: the call throws');
    assert.equal(heldAfterThrow, 1, 'though the result is held');
    assert.equal(heldAfterRetry, 2, 'predicted: a retry holds it again');
    assert.equal(heldAfterRestart.length, 2, 'both holds outlive a restart');
  });

  it('R: a release whose write fails makes deliverAgentResult throw after the result landed; a retry delivers it twice', async () => {
    const gates = new GateModule();
    const framework = await boot(gates);
    framework.start();
    const job = await startBlocked(framework, gates, 'job3', 'g-job3',
      workerSpec('job3', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    gates.release('g-job3');
    assert.ok((await job.settled).ok);
    const internals = framework as unknown as { persistAgentRegistry(snapshot: { mail: unknown[] }): void };
    const original = internals.persistAgentRegistry.bind(framework);
    let writes = 0;
    // The hold's write succeeds; the next, the release at the landing, fails.
    internals.persistAgentRegistry = (snapshot) => {
      writes++;
      if (writes === 2) throw new Error('EIO: simulated write failure');
      original(snapshot);
    };
    let threw: string | null = null;
    try {
      framework.deliverAgentResult('job3', [{ type: 'text', text: 'RESULT-R' }]);
    } catch (error) {
      threw = String(error).slice(0, 160);
    } finally {
      internals.persistAgentRegistry = original;
    }
    const inMiraAfterThrow = rowsWith(framework, 'mira', 'RESULT-R');
    const heldAfterThrow = framework.listHeldMail().length;
    framework.deliverAgentResult('job3', [{ type: 'text', text: 'RESULT-R' }]);
    const inMiraAfterRetry = rowsWith(framework, 'mira', 'RESULT-R');
    const observed = { writes, threw, inMiraAfterThrow, heldAfterThrow, inMiraAfterRetry };
    console.log('IMOGEN-R', JSON.stringify(observed));
    assert.ok(threw, 'predicted: the call throws');
    assert.equal(inMiraAfterThrow, 1, 'though the result is in mira\'s window');
    assert.equal(inMiraAfterRetry, 2, 'predicted: a retry delivers it twice');
  });

  it('T: a stop whose write fails throws, leaves the agent running, and a second stop is refused', async () => {
    const gates = new GateModule();
    const framework = await boot(gates);
    framework.start();
    await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const internals = framework as unknown as { persistAgentRegistry(snapshot: unknown): void };
    const original = internals.persistAgentRegistry.bind(framework);
    internals.persistAgentRegistry = () => { throw new Error('EIO: simulated write failure'); };
    let threw: string | null = null;
    try {
      framework.stopAgent('boss', { by: 'mira' });
    } catch (error) {
      threw = String(error).slice(0, 160);
    } finally {
      internals.persistAgentRegistry = original;
    }
    const afterThrow = { recordEnded: framework.getAgentRecord('boss')?.ended?.reason ?? null, running: framework.getAgent('boss') !== null };
    let secondStop: string | null = null;
    try {
      framework.stopAgent('boss', { by: 'mira' });
    } catch (error) {
      secondStop = String(error).slice(0, 160);
    }
    const observed = { threw, afterThrow, secondStop, stillRunning: framework.getAgent('boss') !== null };
    console.log('IMOGEN-T', JSON.stringify(observed));
    assert.ok(threw, 'predicted: the stop throws');
    assert.equal(afterThrow.recordEnded, 'stopped', 'predicted: the registry already records it ended');
    assert.equal(afterThrow.running, true, 'predicted: but the agent is still running');
    assert.ok(secondStop, 'predicted: and a second stop is refused');
  });

  it('S: a failed sync makes deliverAgentResult throw with the result held; a retry delivers it, and the restart delivers the first again', async () => {
    const gates = new GateModule();
    const framework = await boot(gates);
    framework.start();
    const job = await startBlocked(framework, gates, 'job2', 'g-job2',
      workerSpec('job2', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    gates.release('g-job2');
    assert.ok((await job.settled).ok);
    const store = framework.getStore();
    Object.defineProperty(store, 'sync', { configurable: true, writable: true, value: () => { throw new Error('EIO: simulated sync failure'); } });
    let threw: string | null = null;
    try {
      framework.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-S' }]);
    } catch (error) {
      threw = String(error).slice(0, 200);
    } finally {
      delete (store as unknown as Record<string, unknown>).sync;
    }
    const heldAfterThrow = framework.listHeldMail().length;
    const retry = framework.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-S' }]);
    const inMiraAfterRetry = rowsWith(framework, 'mira', 'RESULT-S');
    await framework.stop();
    const second = await boot();
    const inMiraAfterRestart = rowsWith(second, 'mira', 'RESULT-S');
    const observed = { threw, heldAfterThrow, retryDelivered: retry.delivered, inMiraAfterRetry, inMiraAfterRestart, heldAfterRestart: second.listHeldMail().length };
    console.log('IMOGEN-S', JSON.stringify(observed));
    assert.ok(threw, 'predicted: the call throws');
    assert.equal(heldAfterThrow, 1);
    assert.equal(inMiraAfterRetry, 1, 'the retry delivers');
    assert.equal(inMiraAfterRestart, 2, 'predicted: the restart delivers the first hold again');
  });
});
