/**
 * Probes for agent-framework #546 (Dendrite) at 220f4cff: findings 1 to 3 of
 * the review comment, by Hilda-2681. Not part of the PR.
 *
 * Each probe makes a result that only the registry holds: the PR's own
 * orphan flow (dendrite-lifecycle "orphans task work when its parent ends"),
 * where the job's result is held as `recipient-gone` until someone adopts it.
 *
 * 1. A registry `create()` can't read, or stored in a form it doesn't read,
 *    is taken as "no registry yet" and overwritten.
 * 2. A failed registry write or ended-log append, and a failed sync before a
 *    result's delivery, are logged and the call goes on as if it had held.
 * 3. The registry is Chronicle state, so it follows the store's branch: an
 *    undo of a turn that began before the hold, then a restart, reads the
 *    registry as of the undo point. The host-mode record, a recovery file,
 *    doesn't follow the branch.
 *
 * Each test asserts the predicted behaviour, so a pass shows it; a failure
 * shows the prediction was wrong. Observed values are logged as JSON.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, workerSpec } from '../../src/index.js';
import type { AgentSpec } from '../../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from '../helpers/dendrite.js';

const REGISTRY = 'framework/dendrite';
const ENDED = 'framework/dendrite/ended';

type Method = 'setStateJson' | 'appendToStateJson' | 'sync';

/** Make one store method throw (for one state id, if given) until the returned undo runs. */
function failOn(store: JsStore, method: Method, stateId?: string): () => void {
  const original = (store as unknown as Record<Method, (...args: unknown[]) => unknown>)[method].bind(store);
  Object.defineProperty(store, method, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      if (stateId === undefined || args[0] === stateId) throw new Error(`EIO: simulated ${method} failure`);
      return original(...args);
    },
  });
  return () => { delete (store as unknown as Record<string, unknown>)[method]; };
}

describe('probes 1 to 3: the registry\'s durable state', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hilda-546-durable-'));
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

  async function startBlocked(
    framework: AgentFramework, gates: GateModule, name: string, gate: string,
    spec: Omit<AgentSpec, 'name'>, finalText = `${name} done`,
  ) {
    membrane.script(name, waitCall(gate), say(finalText));
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      spec,
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const settled = framework.runEphemeralToCompletion(agent, contextManager).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await until(() => gates.entered.has(gate), `${name} to block on ${gate}`);
    return { settled };
  }

  /**
   * The PR's orphan flow: boss starts job, boss is stopped, job finishes, and
   * its result is held for adoption. Hooks run just before the stop and just
   * before the hold.
   */
  async function heldResult(
    framework: AgentFramework, gates: GateModule,
    hooks: { beforeStop?: () => void; beforeHold?: () => void } = {},
  ) {
    framework.start();
    await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(
      framework, gates, 'job', 'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }),
      'job result',
    );
    hooks.beforeStop?.();
    const stopped = framework.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    const done = await job.settled;
    assert.ok(done.ok, 'the orphaned job finishes');
    hooks.beforeHold?.();
    const delivery = framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    return { stopped: stopped.ended.name, delivery };
  }

  function rewriteStored(write: (store: JsStore) => void): void {
    const store = JsStore.openOrCreate({ path: storePath() });
    try {
      write(store);
      store.sync();
    } finally {
      store.close();
    }
  }

  for (const [label, damage] of [
    ['1a, a registry stored in another version', (store: JsStore) => {
      const stored = store.getStateJson(REGISTRY) as Record<string, unknown>;
      store.setStateJson(REGISTRY, { ...stored, version: 2 });
    }],
    ['1b, a registry whose read fails', (store: JsStore) => {
      store.setState(REGISTRY, Buffer.from('{"version":1,"records":['));
    }],
  ] as const) {
    it(`${label}: create() goes on, the held result is gone, and the stored registry is overwritten`, async () => {
      const gates = new GateModule();
      const first = await boot(gates);
      const { delivery } = await heldResult(first, gates);
      const held = first.listHeldMail().map((m) => [m.to, m.heldBecause]);
      await first.stop();

      let readBack: string;
      rewriteStored((store) => {
        damage(store);
        try { readBack = JSON.stringify(store.getStateJson(REGISTRY)).slice(0, 60); } catch (error) { readBack = `throws: ${String(error).slice(0, 80)}`; }
      });

      let refused: string | null = null;
      let second: AgentFramework | null = null;
      try { second = await boot(); } catch (error) { refused = String(error).slice(0, 200); }
      let storedAfterBoot: unknown = null;
      try {
        const stored = second?.getStore().getStateJson(REGISTRY) as { version?: number; mail?: unknown[] } | null | undefined;
        storedAfterBoot = stored ? { version: stored.version, mail: stored.mail?.length ?? null } : null;
      } catch (error) {
        storedAfterBoot = `throws: ${String(error).slice(0, 80)}`;
      }
      const observed = {
        delivered: delivery.delivered,
        heldBefore: held,
        readBack: readBack!,
        refused,
        heldAfter: second?.listHeldMail().length ?? null,
        jobKnown: second ? second.getAgentRecord('job') !== null : null,
        storedAfterBoot,
      };
      console.log('PROBE-1', label, JSON.stringify(observed));
      assert.deepEqual(observed.heldBefore, [['boss', 'recipient-gone']]);
      assert.equal(refused, null, 'predicted: create() does not refuse');
      assert.equal(observed.heldAfter, 0, 'predicted: the held result is gone');
      assert.deepEqual(observed.storedAfterBoot, { version: 1, mail: 0 }, 'predicted: overwritten as an empty registry at boot');
    });
  }

  it('2a: a failed registry write and a failed ended-log append are logged, the calls go on, and a restart loses both', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const gates = new GateModule();
    const first = await boot(gates);
    const store = first.getStore();
    const undo: Array<() => void> = [];
    let threw: string | null = null;
    let result: Awaited<ReturnType<typeof heldResult>> | null = null;
    try {
      result = await heldResult(first, gates, {
        beforeStop: () => { undo.push(failOn(store, 'appendToStateJson', ENDED)); },
        beforeHold: () => { undo.push(failOn(store, 'setStateJson', REGISTRY)); },
      });
    } catch (error) {
      threw = String(error).slice(0, 200);
    } finally {
      for (const u of undo) u();
    }
    const storedMail = ((store.getStateJson(REGISTRY) as { mail?: unknown[] } | null)?.mail ?? []).length;
    const endedTail = store.getStateTail(ENDED, 256);
    const endedStored = endedTail ? (JSON.parse(endedTail.toString('utf8')) as Array<{ name: string }>).map((r) => r.name) : [];
    const atHold = {
      threw,
      delivered: result?.delivery.delivered ?? null,
      heldInMemory: first.listHeldMail().length,
      storedMail,
      endedStored,
      bossInspectable: first.getAgentRecord('boss') !== null,
      loggedPersist: errors.filter((e) => /\[dendrite\] failed to persist the agent registry/.test(e)).length,
      loggedAppend: errors.filter((e) => /\[dendrite\] failed to append an ended agent record/.test(e)).length,
    };
    await first.stop();
    const second = await boot();
    const afterRestart = {
      heldMail: second.listHeldMail().length,
      bossInspectable: second.getAgentRecord('boss') !== null,
    };
    console.log('PROBE-2a', JSON.stringify({ atHold, afterRestart }));
    assert.equal(atHold.threw, null, 'predicted: neither call fails');
    assert.equal(atHold.heldInMemory, 1, 'held in memory');
    assert.equal(atHold.storedMail, 0, 'not in the stored registry');
    assert.ok(!atHold.endedStored.includes('boss'), 'boss\'s ended record is not in the stored log');
    assert.ok(atHold.loggedPersist >= 1 && atHold.loggedAppend >= 1, 'predicted: each failure is only logged');
    assert.deepEqual(afterRestart, { heldMail: 0, bossInspectable: false }, 'predicted: a restart loses the result and boss\'s record');
  });

  it('2b: a failed sync after holding a result is logged, and the result is delivered anyway', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    const job = await startBlocked(
      first, gates, 'job2', 'g-job2',
      workerSpec('job2', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }),
      'job2 result',
    );
    gates.release('g-job2');
    assert.ok((await job.settled).ok);
    const undo = failOn(first.getStore(), 'sync');
    let threw: string | null = null;
    let delivery: { delivered: boolean } | null = null;
    try {
      delivery = first.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-2' }]);
    } catch (error) {
      threw = String(error).slice(0, 200);
    } finally {
      undo();
    }
    const observed = {
      threw,
      delivered: delivery?.delivered ?? null,
      inMiraWindow: first.getAgent('mira')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('RESULT-2')).length,
      logged: errors.filter((e) => /sync after holding a result failed/.test(e)).length,
    };
    console.log('PROBE-2b', JSON.stringify(observed));
    assert.equal(observed.threw, null, 'predicted: the delivery goes on');
    assert.equal(observed.delivered, true);
    assert.equal(observed.inMiraWindow, 1, 'predicted: the result is in mira\'s window');
    assert.equal(observed.logged, 1, 'predicted: the failed sync is only logged');
  });

  it('3: an undo of a turn that began before the hold, then a restart, loses the held result; the quiesce survives', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    const internals = first as unknown as {
      saveTurnCheckpoints(agent: string, checkpoints: Array<Record<string, unknown>>): void;
    };
    let sequenceBefore = -1;
    const { delivery } = await heldResult(first, gates, {
      beforeHold: () => {
        // mira's last turn began here, before the result was held (as the
        // repository's operator-branch-names test records one).
        sequenceBefore = first.getStore().currentSequence();
        internals.saveTurnCheckpoints('mira', [{
          agentName: 'mira', turnIndex: 0, sequenceBefore, branchName: first.getStore().currentBranch().name, timestamp: Date.now(),
        }]);
      },
    });
    const heldBefore = first.listHeldMail().map((m) => [m.to, m.heldBecause]);
    const quiesce = await first.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    const undone = first.undoLastTurn('mira');
    await first.stop();

    const second = await boot();
    const observed = {
      delivered: delivery.delivered,
      heldBefore,
      quiescedBeforeUndo: quiesce.quiesced,
      undone: { undone: undone.undone, toBranch: undone.toBranch?.replace(/-\d+$/, '-<time>') },
      bootBranch: second.getStore().currentBranch().name.replace(/-\d+$/, '-<time>'),
      quiescedAtBoot: second.getHostModeStatus().quiesced,
      heldAfter: second.listHeldMail().length,
    };
    console.log('PROBE-3', JSON.stringify(observed));
    assert.deepEqual(observed.heldBefore, [['boss', 'recipient-gone']]);
    assert.equal(observed.undone.undone, true);
    assert.equal(observed.quiescedAtBoot, true, 'control: the host-mode record is outside branch history');
    assert.equal(observed.heldAfter, 0, 'predicted: the registry read as of the undo point has no held result');
  });
});
