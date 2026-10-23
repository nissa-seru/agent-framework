/**
 * A probe for agent-framework #546 (Dendrite) at 6ba5f166: finding 1 of the
 * review comment in a store that predates the registry's recovery files, by
 * Hilda-2681. Not part of the PR.
 *
 * At 6ba5f166 the registry's recovery file wins at boot, and the branch-local
 * state is read only for a store without the file. So this probe makes the
 * held result of probes 1a and 1b, removes the recovery files, damages the
 * branch-local registry as 1a and 1b do (stored in another version, or a read
 * that fails), and boots again.
 *
 * Unlike probes 1 to 3, which assert the defect as it stood at 220f4cff, this
 * one asserts the fixed behaviour: create() refuses and names the state.
 * Observed values are logged as JSON.
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

describe('probe 1L: finding 1 in a store that predates the recovery files', () => {
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
    it(`${label}, in a store that predates the recovery files: create() refuses and names the state`, async () => {
      const gates = new GateModule();
      const first = await boot(gates);
      const { delivery } = await heldResult(first, gates);
      const held = first.listHeldMail().map((m) => [m.to, m.heldBecause]);
      await first.stop();

      // A store that predates the recovery files: only the branch-local state.
      rmSync(join(storePath(), 'recovery', 'dendrite-registry.json'), { force: true });
      rmSync(join(storePath(), 'recovery', 'dendrite-ended.json'), { force: true });
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
      console.log('PROBE-1L', label, JSON.stringify(observed));
      assert.deepEqual(observed.heldBefore, [['boss', 'recipient-gone']]);
      assert.ok(refused !== null, 'create() refuses');
      assert.match(refused!, /registry/, 'and names the state');
    });
  }

});
