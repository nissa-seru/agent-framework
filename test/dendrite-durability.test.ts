/**
 * The agent registry's durable state, and the boot and stop paths that
 * deliver what it holds. Built from Hilda-2681's review probes for #546
 * (findings 1 to 5), each turned to assert the fix:
 *
 * 1. A registry or ended log that can't be read, or that isn't in a form
 *    the registry reads, refuses create() rather than being taken as empty
 *    and overwritten. A last ended-log line a crash cut short is dropped.
 * 2. A failed write isn't taken as success. A change a caller asked for
 *    (stopAgent, sendAgentMessage, deliverAgentResult) fails and changes
 *    nothing. A fact recorded after it happened (a run's end) stays in
 *    memory with an ops alert, and the next write carries it.
 * 3. The registry and its ended log are recovery files beside the store, so
 *    a branch switch (an undo) followed by a restart doesn't rewind them.
 * 4. Boot's restart notices and redelivered mail go through the deferred
 *    queue on a quiesced host, so they land once, at resume().
 * 5. stopAgent releases the window of the agent it stops, as the idle reap
 *    does: a failure notice it never read reaches the primary, and a write
 *    queued for it lands in its window.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, workerSpec } from '../src/index.js';
import type { AgentSpec, ProcessEvent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

interface Alert { kind: string; message: string; data?: Record<string, unknown> }

const textOf = (content: ContentBlock[]) =>
  content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('');

function rowsWith(framework: AgentFramework, agent: string, needle: string) {
  return framework.getAgent(agent)!.getContextManager().getAllMessages()
    .filter((message) => textOf(message.content).includes(needle));
}

function captureAlerts(framework: AgentFramework): Alert[] {
  const alerts: Alert[] = [];
  (framework as unknown as { opsAlert: unknown }).opsAlert = (kind: string, _agent: string, message: string, opts?: { data?: Record<string, unknown> }) => {
    alerts.push({ kind, message, data: opts?.data });
  };
  return alerts;
}

/** Make a recovery file unwritable: a directory where the file goes. Returns the undo. */
function blockFile(path: string): () => void {
  const saved = existsSync(path) ? readFileSync(path) : null;
  rmSync(path, { force: true });
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (saved) writeFileSync(path, saved);
  };
}

describe('the agent registry\'s durable state', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-durability-'));
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
  const registryFile = () => join(storePath(), 'recovery', 'agent-registry.json');
  const endedFile = () => join(storePath(), 'recovery', 'agent-registry-ended.jsonl');

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
   * dendrite-lifecycle's orphan flow: boss starts job, boss is stopped, job
   * finishes, and its result is held for adoption, a result only the
   * registry holds.
   */
  async function heldResult(framework: AgentFramework, gates: GateModule) {
    framework.start();
    await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(
      framework, gates, 'job', 'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }),
      'job result',
    );
    framework.stopAgent('boss', { by: 'mira' });
    gates.release('g-job');
    assert.ok((await job.settled).ok, 'the orphaned job finishes');
    const delivery = framework.deliverAgentResult('job', [{ type: 'text', text: 'RESULT-1' }]);
    assert.equal(delivery.delivered, false, 'held: its recipient is gone');
    assert.deepEqual(framework.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
  }

  describe('finding 1: what boot can\'t read refuses create()', () => {
    for (const [label, damage, says] of [
      ['a registry in another version', () => {
        const stored = JSON.parse(readFileSync(registryFile(), 'utf8')) as Record<string, unknown>;
        writeFileSync(registryFile(), JSON.stringify({ ...stored, version: 2 }));
      }, /is version 2, which this framework doesn't read/],
      ['a registry that isn\'t JSON', () => {
        writeFileSync(registryFile(), '{"version":1,"records":[');
      }, /holds text that isn't JSON/],
      ['held mail that isn\'t mail', () => {
        const stored = JSON.parse(readFileSync(registryFile(), 'utf8')) as { mail: unknown[] };
        stored.mail.push('not mail');
        writeFileSync(registryFile(), JSON.stringify(stored));
      }, /has held mail \(2 of 2\) that is a string, not held mail/],
      ['an ended-log line that isn\'t JSON', () => {
        appendFileSync(endedFile(), 'not json\n');
      }, /agent-registry-ended\.jsonl\) holds text that isn't JSON: line \d+ of \d+ isn't JSON/],
      ['an ended-log line that isn\'t an ended record', () => {
        appendFileSync(endedFile(), '{"name":"ghost"}\n');
      }, /agent-registry-ended\.jsonl\) has an ended record \(\d+ of the \d+ read\) that has no incarnation/],
    ] as const) {
      it(`${label}: create() refuses, naming it, and leaves it as it was`, async () => {
        const gates = new GateModule();
        const first = await boot(gates);
        await heldResult(first, gates);
        await first.stop();
        damage();
        const registryBefore = readFileSync(registryFile(), 'utf8');
        const endedBefore = readFileSync(endedFile(), 'utf8');

        await assert.rejects(boot(), (error: Error) => {
          assert.match(error.message, /^the agent registry \(/);
          assert.match(error.message, says);
          assert.match(error.message, /The framework doesn't start without it/);
          return true;
        });
        assert.equal(readFileSync(registryFile(), 'utf8'), registryBefore, 'the registry is left as it was');
        assert.equal(readFileSync(endedFile(), 'utf8'), endedBefore, 'the ended log is left as it was');
      });
    }

    it('a last ended-log line a crash cut short is dropped, and the log goes on from the last whole line', async () => {
      const gates = new GateModule();
      const first = await boot(gates);
      await heldResult(first, gates);
      await first.stop();
      const whole = readFileSync(endedFile(), 'utf8');
      appendFileSync(endedFile(), '{"name":"half-writ');

      const second = await boot();
      assert.equal(readFileSync(endedFile(), 'utf8'), whole, 'cut back to the last whole line');
      assert.equal(second.getAgentRecord('boss')?.ended?.reason, 'stopped', 'the history before it is kept');
      assert.deepEqual(second.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
    });

    it('nothing stored is an empty registry', async () => {
      const framework = await boot();
      assert.deepEqual(framework.listHeldMail(), []);
      assert.equal(framework.getAgentRecord('mira')?.incarnation, 1);
    });

    it('without a storePath, the store\'s own state is read, and a form it doesn\'t read refuses too', async () => {
      const store = JsStore.openOrCreate({ path: storePath() });
      try {
        const create = () => AgentFramework.create({
          store,
          membrane: membrane.asMembrane(),
          agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
          modules: [],
          syncIntervalMs: 0,
        });
        const first = await create();
        await first.stop();
        store.setStateJson('framework/dendrite', { version: 2, records: [], incarnations: {}, mail: [] });
        await assert.rejects(create(), /^Error: the agent registry \(the store's framework\/dendrite state\) is version 2/);
      } finally {
        store.close();
      }
    });
  });

  describe('finding 2: a failed write isn\'t a success', () => {
    it('a stop that can\'t be stored fails, and the agent keeps running', async () => {
      const gates = new GateModule();
      const framework = await boot(gates);
      framework.start();
      await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
      const unblock = blockFile(registryFile());
      try {
        assert.throws(() => framework.stopAgent('boss', { by: 'mira' }),
          /^Error: the agent registry couldn't be stored in .*agent-registry\.json: /);
      } finally {
        unblock();
      }
      assert.equal(framework.getAgentRecord('boss')?.ended, undefined, 'boss is still live in the registry');
      assert.ok(framework.getAgent('boss'), 'and still running');
      framework.stopAgent('boss', { by: 'mira' });
      assert.equal(framework.getAgentRecord('boss')?.ended?.reason, 'stopped', 'a stop once the write works ends it');
    });

    it('a message that can\'t be stored isn\'t sent', async () => {
      const framework = await boot();
      const unblock = blockFile(registryFile());
      try {
        assert.throws(() => framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'MAIL-X' }]),
          /couldn't be stored/);
      } finally {
        unblock();
      }
      assert.deepEqual(framework.listHeldMail(), []);
      assert.equal(rowsWith(framework, 'mira', 'MAIL-X').length, 0);
    });

    it('a result that can\'t be held isn\'t delivered, and delivering it again holds it once', async () => {
      const gates = new GateModule();
      const framework = await boot(gates);
      framework.start();
      const job = await startBlocked(
        framework, gates, 'job2', 'g-job2',
        workerSpec('job2', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }),
        'job2 result',
      );
      gates.release('g-job2');
      assert.ok((await job.settled).ok);
      const unblock = blockFile(registryFile());
      try {
        assert.throws(() => framework.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-2' }]), /couldn't be stored/);
      } finally {
        unblock();
      }
      assert.deepEqual(framework.listHeldMail(), [], 'nothing held');
      assert.equal(rowsWith(framework, 'mira', 'RESULT-2').length, 0, 'nothing delivered');
      const again = framework.deliverAgentResult('job2', [{ type: 'text', text: 'RESULT-2' }]);
      assert.equal(again.delivered, true);
      assert.equal(rowsWith(framework, 'mira', 'RESULT-2').length, 1, 'delivered once');
    });

    it('a release waits for the store to sync: when the sync fails, the mail stays held', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const framework = await boot();
      const store = framework.getStore();
      Object.defineProperty(store, 'sync', { configurable: true, writable: true, value: () => { throw new Error('EIO: sync'); } });
      try {
        const sent = framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'MAIL-S' }]);
        assert.equal(sent.delivered, true);
        assert.equal(rowsWith(framework, 'mira', 'MAIL-S').length, 1, 'the message is in the store\'s view');
        assert.equal(framework.listHeldMail().length, 1, 'but its release waits: the message may not be on disk');
        assert.ok(errors.some((line) => /stays held: the store's sync before its release failed/.test(line)));
      } finally {
        delete (store as unknown as Record<string, unknown>).sync;
      }
      await framework.stop();
      const second = await boot();
      assert.equal(rowsWith(second, 'mira', 'MAIL-S').length, 1, 'a restart finds it stored');
      assert.equal(second.listHeldMail().length, 0, 'and releases it, once');
    });

    it('without a storePath, a result the store can\'t sync is neither held nor delivered', async () => {
      const store = JsStore.openOrCreate({ path: storePath() });
      const gates = new GateModule();
      const framework = await AgentFramework.create({
        store,
        membrane: membrane.asMembrane(),
        agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
        modules: [gates],
        syncIntervalMs: 0,
      });
      try {
        framework.start();
        const job = await startBlocked(
          framework, gates, 'job4', 'g-job4',
          workerSpec('job4', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }),
        );
        gates.release('g-job4');
        assert.ok((await job.settled).ok);
        Object.defineProperty(store, 'sync', { configurable: true, writable: true, value: () => { throw new Error('EIO: sync'); } });
        try {
          assert.throws(() => framework.deliverAgentResult('job4', [{ type: 'text', text: 'RESULT-4' }]),
            /couldn't be made durable \(the store's sync failed: EIO: sync\), so it was neither held nor delivered/);
        } finally {
          delete (store as unknown as Record<string, unknown>).sync;
        }
        assert.deepEqual(framework.listHeldMail(), []);
        assert.equal(rowsWith(framework, 'mira', 'RESULT-4').length, 0);
        assert.deepEqual((store.getStateJson('framework/dendrite') as { mail: unknown[] }).mail, [], 'taken back in the store too');
      } finally {
        await framework.stop();
        store.close();
      }
    });

    it('a run\'s end that can\'t be stored stays in memory with an alert, and the next write carries it', async () => {
      const gates = new GateModule();
      const framework = await boot(gates);
      const alerts = captureAlerts(framework);
      framework.start();
      const job = await startBlocked(framework, gates, 'job3', 'g-job3', workerSpec('job3', { spawnedBy: 'mira' }));
      const unblock = blockFile(registryFile());
      try {
        gates.release('g-job3');
        assert.ok((await job.settled).ok, 'the run ends all the same');
      } finally {
        unblock();
      }
      assert.equal(framework.getAgentRecord('job3')?.ended?.reason, 'completed', 'the end is kept in memory');
      const registryAlerts = alerts.filter((alert) => alert.kind === 'agent-registry');
      assert.equal(registryAlerts.length, 1, 'one alert for the failed write');
      assert.match(registryAlerts[0]!.message, /its next change writes it again/);
      assert.equal(registryAlerts[0]!.data?.code, 'EISDIR');

      // The next change writes the registry whole, the end included.
      framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'after' }]);
      await framework.stop();
      const second = await boot();
      assert.equal(second.getAgentRecord('job3')?.ended?.reason, 'completed', 'the restart knows the end');
    });

    it('an ended record the log can\'t take stays in the snapshot until it can, and a restart keeps it', async () => {
      const gates = new GateModule();
      const framework = await boot(gates);
      const alerts = captureAlerts(framework);
      framework.start();
      const unblock = blockFile(endedFile());
      await startBlocked(framework, gates, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
      framework.stopAgent('boss', { by: 'mira' });
      assert.equal(alerts.filter((alert) => alert.kind === 'agent-registry').length, 1, 'the append\'s failure is alerted');
      const stored = JSON.parse(readFileSync(registryFile(), 'utf8')) as { unlogged?: Array<{ name: string }> };
      assert.deepEqual(stored.unlogged?.map((record) => record.name), ['boss'], 'the snapshot carries the unlogged end');
      unblock();
      rmSync(endedFile(), { force: true });
      await framework.stop();

      const second = await boot();
      assert.equal(second.getAgentRecord('boss')?.ended?.reason, 'stopped', 'the restart restores it from the snapshot');
      const logged = readFileSync(endedFile(), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { name: string }).name);
      assert.ok(logged.includes('boss'), 'and appends it to the log');
    });
  });

  it('finding 3: an undo, then a restart, keeps the held result', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    const internals = first as unknown as {
      saveTurnCheckpoints(agent: string, checkpoints: Array<Record<string, unknown>>): void;
    };
    // mira's last turn began here, before the result was held.
    const sequenceBefore = first.getStore().currentSequence();
    internals.saveTurnCheckpoints('mira', [{
      agentName: 'mira', turnIndex: 0, sequenceBefore, branchName: first.getStore().currentBranch().name, timestamp: Date.now(),
    }]);
    await heldResult(first, gates);
    const quiesce = await first.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(quiesce.quiesced, true);
    const undone = first.undoLastTurn('mira');
    assert.equal(undone.undone, true);
    await first.stop();

    const second = await boot();
    assert.notEqual(second.getStore().currentBranch().name, 'main', 'the store booted on the undo branch');
    assert.equal(second.getHostModeStatus().quiesced, true);
    assert.deepEqual(second.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']],
      'the held result outlives the branch switch');
    assert.equal(second.getAgentRecord('boss')?.ended?.reason, 'stopped', 'so does boss\'s ended record');
  });

  it('a store from before the recovery files moves into them, its ended history first', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    await heldResult(first, gates);
    await first.stop();
    // As a store from before the change: the registry in the store's states only.
    const snapshot = JSON.parse(readFileSync(registryFile(), 'utf8')) as Record<string, unknown>;
    const ended = readFileSync(endedFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    const store = JsStore.openOrCreate({ path: storePath() });
    try {
      store.setStateJson('framework/dendrite', snapshot);
      for (const record of ended) store.appendToStateJson('framework/dendrite/ended', record);
      store.sync();
    } finally {
      store.close();
    }
    rmSync(join(storePath(), 'recovery', 'agent-registry.json'));
    rmSync(join(storePath(), 'recovery', 'agent-registry-ended.jsonl'));

    const second = await boot();
    assert.deepEqual(second.listHeldMail().map((m) => [m.to, m.heldBecause]), [['boss', 'recipient-gone']]);
    assert.ok(existsSync(registryFile()), 'the registry is in its file');
    const logged = readFileSync(endedFile(), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { name: string }).name);
    assert.deepEqual(logged, ended.map((record) => (record as { name: string }).name), 'the ended history moved first');
  });
});

describe('finding 4: boot delivers through the queue on a quiesced host', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-boot-'));
    membrane = new RoutedMembrane();
    frameworks = [];
  });

  afterEach(async () => {
    for (const framework of frameworks.reverse()) {
      try { await framework.stop(); } catch { /* already stopped */ }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function boot(gates = new GateModule()): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
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

  it('held mail the queue holds lands once, at resume', async () => {
    const first = await boot();
    await first.quiesce({ reason: 'maintenance' });
    first.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'MAIL-1' }]);
    assert.equal(first.listHeldMail().length, 1);
    await first.stop();

    const second = await boot();
    assert.equal(second.getHostModeStatus().quiesced, true);
    assert.equal(rowsWith(second, 'mira', 'MAIL-1').length, 0, 'nothing lands while quiesced');
    await second.resume();
    const rows = rowsWith(second, 'mira', 'MAIL-1');
    assert.equal(rows.length, 1, 'it lands once');
    assert.equal(second.listHeldMail().length, 0, 'and its landing releases it');
  });

  it('held mail the queue doesn\'t hold waits for resume, then lands once', async () => {
    const first = await boot();
    // Mail only the registry holds: held, with its message never in the
    // store or the queue, as when the process stops before its delivery.
    const registry = (first as unknown as { registry: { holdMail(mail: Record<string, unknown>): unknown } }).registry;
    registry.holdMail({ kind: 'message', from: { agent: 'oren', incarnation: 1 }, to: 'mira', content: [{ type: 'text', text: 'MAIL-3' }] });
    await first.quiesce({ reason: 'maintenance' });
    await first.stop();

    const second = await boot();
    assert.equal(second.getHostModeStatus().quiesced, true);
    assert.equal(rowsWith(second, 'mira', 'MAIL-3').length, 0, 'redelivery waits for resume');
    await second.resume();
    assert.equal(rowsWith(second, 'mira', 'MAIL-3').length, 1, 'then lands once');
    assert.equal(second.listHeldMail().length, 0);
  });

  it('an interrupted job\'s restart notice waits for resume on a quiesced host', async () => {
    const gates = new GateModule();
    const first = await boot(gates);
    first.start();
    membrane.script('job', waitCall('job'), say('job done'));
    const { agent, contextManager } = await first.createEphemeralAgent(
      { name: 'job', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }),
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    first.runEphemeralToCompletion(agent, contextManager).catch(() => { /* cut off by the restart */ });
    await until(() => gates.entered.has('job'), 'job to block');
    await first.quiesce({ reason: 'maintenance', timeoutMs: 1_000 });
    await first.stop();

    const second = await boot();
    const notices = () => second.getAgent('mira')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-lifecycle')
      .map((m) => textOf(m.content));
    assert.equal(second.getHostModeStatus().quiesced, true);
    assert.equal(second.getAgentRecord('job')?.ended?.reason, 'host-restart');
    assert.deepEqual(notices(), [], 'not written while quiesced');
    await second.resume();
    assert.equal(notices().filter((text) => text.includes('the host restarted')).length, 1, 'written once, at resume');
  });
});

function internals(framework: AgentFramework) {
  return framework as unknown as {
    initializeMcpl(servers: []): Promise<void>;
    activeTurnTokens: Map<string, number>;
    deferredMessages: Array<{ forAgent?: string; metadata?: Record<string, unknown> }>;
    pendingAssistantBlocks: Map<string, unknown[]>;
    quiesced: boolean;
    deferredWritesPersisted: boolean;
    unackedDeferredWrites: unknown[];
    flushDeferredWrites(label: string): Promise<void>;
    addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  };
}

const SEND_FAILED = '[discord-send-failed]';
const count = (messages: Array<{ content: unknown }>, needle: string) =>
  messages.filter((m) => JSON.stringify(m.content).includes(needle)).length;

describe('finding 5: stopAgent releases the window, as the idle reap does', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-stop-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
        { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
      ],
      modules: [],
      conversations: { templateAgent: 'primary' },
      speech: { locus: 'latest-inbound' },
    });
    await internals(framework).initializeMcpl([]);
  });

  afterEach(async () => {
    internals(framework).activeTurnTokens.clear();
    internals(framework).pendingAssistantBlocks.clear();
    internals(framework).quiesced = false;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A real conversation fork, as route-failure-targeting's: its reply fails (no such channel). */
  async function spawnFork() {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Reply from the fork.' }]));
    framework.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'srv',
      channelId: 'missing-channel',
      messageId: 'incoming-1',
      author: { id: 'user-1', name: 'User' },
      content: [{ type: 'text', text: 'Hello fork.' }],
      timestamp: new Date().toISOString(),
      metadata: { channel_type: 'im' },
      triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const binding = framework.getConversationRouter()!.getBinding('missing-channel');
    assert.ok(binding, 'the incoming DM must spawn a real conversation fork');
    return framework.getAgent(binding.agentName)!;
  }

  async function forkWindowHas(forkName: string, needle: string): Promise<boolean> {
    const archive = await ContextManager.open({
      store: framework.getStore(), namespace: 'conversations/' + forkName, isolate: true, strategy: new PassthroughStrategy(),
    });
    return archive.getAllMessages().some((m) => JSON.stringify(m.content).includes(needle));
  }

  it('a failure notice the stopped fork stored but never read reaches the primary', async () => {
    const fork = await spawnFork();
    framework.stopAgent(fork.name, { by: 'test', reason: 'test' });
    const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
    assert.equal(framework.getAgent(fork.name), null);
    assert.equal(count(messages, SEND_FAILED), 1);
  });

  it('a write queued for the stopped fork lands in its window', async () => {
    const fork = await spawnFork();
    const state = internals(framework);
    state.deferredWritesPersisted = true;
    state.activeTurnTokens.set(fork.name, 3);
    state.addMessage('user', [{ type: 'text', text: 'queued for the fork' }], { kind: 'test-note' }, { forAgent: fork.name });
    assert.equal(state.deferredMessages.length, 1);
    state.activeTurnTokens.delete(fork.name);

    framework.stopAgent(fork.name, { by: 'test', reason: 'test' });
    assert.equal(framework.getAgent(fork.name), null);
    assert.equal(state.deferredMessages.length, 0, 'drained from the queue');
    assert.equal(state.unackedDeferredWrites.length, 0, 'and acknowledged');
    assert.equal(await forkWindowHas(fork.name, 'queued for the fork'), true, 'into the fork\'s window');
  });

  it('while quiesced, the stopped fork\'s window is released at resume', async () => {
    const fork = await spawnFork();
    await framework.quiesce({ reason: 'test' });
    framework.stopAgent(fork.name, { by: 'test', reason: 'test' });
    const before = await framework.getAgent('primary')!.getContextManager().compile();
    assert.equal(count(before.messages, SEND_FAILED), 0, 'nothing lands mid-surgery');
    await framework.resume();
    const after = await framework.getAgent('primary')!.getContextManager().compile();
    assert.equal(count(after.messages, SEND_FAILED), 1);
  });
});
