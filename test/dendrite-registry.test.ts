/**
 * Dendrite agent registry — the bookkeeping rules, without a framework:
 * roles, spec validation, ending (cascade vs orphan), reparenting, held
 * mail, and restart behaviour by lifetime.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRegistry,
  AgentSpecError,
  RegistryFormError,
  conversationForkSpec,
  residentSpec,
  subconsciousSpec,
  taskForkSpec,
  workerSpec,
} from '../src/index.js';
import type { AgentRecord, RegistrySnapshot } from '../src/index.js';

/** A registry with a persisted side: the last snapshot and the ended log. */
function persisted() {
  const state: { snapshot: RegistrySnapshot | null; ended: AgentRecord[]; writes: number } = {
    snapshot: null,
    ended: [],
    writes: 0,
  };
  let clock = 1_000;
  const make = () =>
    new AgentRegistry({
      now: () => ++clock,
      persist: (snapshot) => {
        state.snapshot = JSON.parse(JSON.stringify(snapshot));
        state.writes++;
      },
      appendEnded: (record) => {
        state.ended.push(JSON.parse(JSON.stringify(record)));
      },
    });
  return { state, make };
}

describe('AgentRegistry roles', () => {
  it('answers each selection question from declared roles, not kinds', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(subconsciousSpec('Subconscious', 'mira'));
    registry.register(conversationForkSpec('mira-chan-1', { template: 'mira', channelId: 'c1', idleTtlMs: 60_000 }));
    registry.register(workerSpec('worker-1', { spawnedBy: 'mira' }));

    assert.equal(registry.primary(), 'mira');
    assert.deepEqual(registry.untargetedRecipients(), ['mira', 'oren']);
    // The gate is host-wide: a channel-bound fork is woken by its own
    // channel's debounced traffic without being a broadcast recipient.
    assert.deepEqual(registry.gateRecipients(), ['mira', 'oren', 'mira-chan-1']);
    assert.deepEqual(registry.sharedSlotReaders(), ['mira', 'oren', 'Subconscious']);
    assert.equal(registry.ownsProviderScheduling('mira'), true);
    assert.equal(registry.ownsProviderScheduling('Subconscious'), true);
    assert.equal(registry.ownsProviderScheduling('mira-chan-1'), false);
    assert.equal(registry.ownsProviderScheduling('worker-1'), false);
    assert.equal(registry.ownsProviderScheduling('nobody'), false);
    assert.equal(registry.homeChannel('mira-chan-1'), 'c1');
    assert.equal(registry.homeChannel('mira'), undefined);
  });

  it('a spec outside every preset is selected by its roles alone', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register({
      name: 'night-watch',
      kind: 'watcher',
      roles: { defaultDelivery: false, receivesUntargeted: true, receivesGateWakes: false, ownsProviderScheduling: false },
      lifetime: { kind: 'persistent' },
    });
    assert.deepEqual(registry.untargetedRecipients(), ['mira', 'night-watch']);
    assert.deepEqual(registry.gateRecipients(), ['mira']);
  });
});

describe('AgentRegistry spec validation', () => {
  const base = () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    return registry;
  };

  it('refuses a second default-delivery owner', () => {
    const registry = base();
    assert.throws(() => registry.register(residentSpec('oren', { primary: true })), /default delivery already belongs to "mira"/);
    assert.equal(registry.has('oren'), false);
  });

  it('refuses a task that could run forever', () => {
    const registry = base();
    assert.throws(
      () => registry.register({ ...workerSpec('w'), lifetime: { kind: 'task' } }),
      (error: unknown) => error instanceof AgentSpecError && /every task agent must end/.test(error.message),
    );
    assert.throws(
      () => registry.register({ ...workerSpec('w'), lifetime: { kind: 'task', deadlineMs: 0 } }),
      AgentSpecError,
    );
    // Either bound is enough.
    registry.register({ ...workerSpec('w1'), lifetime: { kind: 'task', deadlineMs: 5_000 } });
    registry.register({ ...workerSpec('w2'), lifetime: { kind: 'task', idleTimeoutMs: 5_000 } });
  });

  it('refuses an idle lifetime with no TTL', () => {
    const registry = base();
    assert.throws(
      () => registry.register(conversationForkSpec('f', { template: 'mira', channelId: 'c', idleTtlMs: 0 })),
      /positive idleTtlMs/,
    );
  });

  it('refuses relationships that name nobody', () => {
    const registry = base();
    assert.throws(() => registry.register(workerSpec('w', { spawnedBy: 'ghost' })), /spawner "ghost" is not a registered agent/);
    assert.throws(
      () => registry.register(workerSpec('w', { resultTo: { to: 'ghost', as: 'message' } })),
      /result recipient "ghost"/,
    );
    assert.throws(() => registry.register(taskForkSpec('w', { parent: 'ghost' })), /"ghost" is not a registered agent/);
    assert.throws(
      () => registry.register({ ...workerSpec('w'), observes: [{ agent: 'ghost' }] }),
      /observed agent "ghost"/,
    );
    assert.throws(() => registry.register({ ...workerSpec('w'), onParentEnd: 'end' }), /needs a spawnedBy/);
    assert.throws(() => registry.register(residentSpec('mira', { primary: false })), /already registered/);
    assert.deepEqual(registry.list().map((r) => r.name), ['mira']);
  });
});

describe('AgentRegistry ending and orphans', () => {
  it('ends attention tenants with their parent and orphans task work', () => {
    const { state, make } = persisted();
    const registry = make();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(taskForkSpec('fork', { parent: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    // Two things spawned by the fork: a reader that serves it, and a job.
    registry.register({ ...workerSpec('reader', { spawnedBy: 'fork' }), onParentEnd: 'end' });
    registry.register(workerSpec('job', { spawnedBy: 'fork', resultTo: { to: 'fork', as: 'message' } }));
    // The reader has a tenant of its own.
    registry.register({ ...workerSpec('reader-aide', { spawnedBy: 'reader' }), onParentEnd: 'end' });

    const outcome = registry.end('fork', 'stopped', 'operator')!;

    assert.equal(outcome.ended.name, 'fork');
    assert.deepEqual(outcome.ended.ended, { at: outcome.ended.ended!.at, reason: 'stopped', by: 'operator' });
    // Deepest first, so a caller tearing them down never removes a parent before its tenant.
    assert.deepEqual(outcome.cascaded.map((r) => r.name), ['reader-aide', 'reader']);
    assert.ok(outcome.cascaded.every((r) => r.ended?.reason === 'parent-ended'));
    assert.deepEqual(outcome.orphaned.map((o) => o.record.name), ['job']);
    // Offered to the nearest live ancestor of the agent that ended.
    assert.deepEqual(outcome.orphaned[0]!.candidates, ['mira']);

    const job = registry.get('job')!;
    assert.equal(job.orphaned?.formerParent.agent, 'fork');
    assert.equal(job.orphaned?.reason, 'stopped');
    assert.deepEqual(job.orphaned?.candidates, ['mira']);
    // The spawn edge is history; it is no longer a child of anyone.
    assert.deepEqual(registry.children('fork'), []);
    // Its result route is left pointing at the ended agent: delivery holds, not drops.
    assert.equal(job.relationships.resultTo?.to, 'fork');

    assert.deepEqual(registry.list().map((r) => r.name), ['mira', 'job']);
    assert.equal(registry.inspect('reader')?.ended?.reason, 'parent-ended');
    assert.deepEqual(state.ended.map((r) => r.name), ['fork', 'reader', 'reader-aide']);
    assert.ok(!state.snapshot!.records.some((r) => r.ended), 'ended history stays out of the snapshot');
    assert.equal(registry.end('fork', 'stopped'), null, 'ending twice is a no-op');
  });

  it('offers an orphan to the nearest LIVE ancestor, then the primary', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(workerSpec('a', { spawnedBy: 'oren' }));
    registry.register(workerSpec('b', { spawnedBy: 'a' }));
    registry.register(workerSpec('c', { spawnedBy: 'b' }));

    const outcome = registry.end('b', 'failed')!;
    assert.deepEqual(outcome.orphaned[0]!.candidates, ['a', 'oren', 'mira']);
  });

  it('reparenting clears orphan state, reroutes a dead result route and returns held mail', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('boss', { spawnedBy: 'mira' }));
    registry.register(workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }));
    registry.end('boss', 'stopped');

    const mail = registry.holdMail({
      kind: 'result',
      from: registry.ref('job'),
      to: 'boss',
      content: [{ type: 'text', text: 'done' }],
      heldBecause: 'recipient-gone',
    });
    assert.deepEqual(registry.listMail({ to: 'boss' }).map((m) => m.id), [mail.id]);

    const { record, deliverable } = registry.reparent('job', 'mira');
    assert.equal(record.orphaned, undefined);
    assert.equal(record.relationships.spawnedBy, 'mira');
    assert.equal(record.relationships.resultTo?.to, 'mira');
    assert.deepEqual(deliverable.map((m) => [m.id, m.to]), [[mail.id, 'mira']]);
    assert.deepEqual(registry.children('mira').map((r) => r.name), ['job']);

    registry.releaseMail(mail.id);
    assert.deepEqual(registry.listMail(), []);
  });

  it('a live result route survives reparenting untouched', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(workerSpec('boss', { spawnedBy: 'mira' }));
    registry.register(workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'oren', as: 'message' } }));
    registry.end('boss', 'stopped');
    const { record, deliverable } = registry.reparent('job', 'mira');
    assert.equal(record.relationships.resultTo?.to, 'oren', 'spawning is not the result route');
    assert.deepEqual(deliverable, []);
  });

  it('refuses a reparenting that would form a cycle', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('a', { spawnedBy: 'mira' }));
    registry.register(workerSpec('b', { spawnedBy: 'a' }));
    assert.throws(() => registry.reparent('a', 'b'), /would form a cycle/);
    assert.throws(() => registry.reparent('a', 'a'), /its own parent/);
    assert.throws(() => registry.reparent('a', 'ghost'), /not a registered agent/);
  });
});

describe('AgentRegistry restart behaviour follows lifetime', () => {
  it('restores a persistent agent as a new incarnation and ends interrupted bounded work', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(subconsciousSpec('Subconscious', 'mira'));
    first.register(workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    first.register(conversationForkSpec('mira-c1', { template: 'mira', channelId: 'c1', idleTtlMs: 1_000 }));
    const held = first.holdMail({
      kind: 'result',
      from: first.ref('job'),
      to: 'mira',
      content: [{ type: 'text', text: 'almost lost' }],
    });
    assert.equal(first.get('mira')!.incarnation, 1);

    // The process dies here. A new one loads what was persisted.
    const second = make();
    const { interrupted } = second.restore(state.snapshot, state.ended);
    assert.deepEqual(interrupted.map((r) => r.name).sort(), ['job', 'mira-c1']);
    assert.ok(interrupted.every((r) => r.ended?.reason === 'host-restart'));
    assert.equal(second.has('mira'), false, 'a persistent agent is not live until configuration declares it');

    second.register(residentSpec('mira', { primary: true }));
    second.register(subconsciousSpec('Subconscious', 'mira'));
    assert.equal(second.get('mira')!.incarnation, 2);
    assert.equal(second.get('Subconscious')!.incarnation, 2);
    assert.deepEqual(second.reconcile().unconfigured, []);

    assert.equal(second.inspect('job')?.ended?.reason, 'host-restart');
    // The result is still held, attributed to the incarnation that produced it.
    assert.deepEqual(second.listMail().map((m) => [m.id, m.from.agent, m.from.incarnation, m.to]), [
      [held.id, 'job', 1, 'mira'],
    ]);
    assert.deepEqual(state.ended.map((r) => r.name).sort(), ['job', 'mira-c1']);
  });

  it('ends a persistent agent the new configuration no longer declares', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(residentSpec('oren', { primary: false }));

    const second = make();
    second.restore(state.snapshot, state.ended);
    second.register(residentSpec('mira', { primary: true }));
    const { unconfigured } = second.reconcile();
    assert.deepEqual(unconfigured.map((o) => [o.ended.name, o.ended.ended?.reason]), [['oren', 'not-configured']]);
    assert.equal(second.inspect('oren')?.ended?.reason, 'not-configured');
    assert.deepEqual(second.list().map((r) => r.name), ['mira']);
  });

  it('a re-used name is a new incarnation while the old record is still referable', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('job'));
    registry.end('job', 'completed');
    assert.equal(registry.register(workerSpec('job')).incarnation, 2);
    assert.equal(registry.list({ includeEnded: true }).filter((r) => r.name === 'job').length, 2);
  });

  it('takes nothing stored as empty, and refuses a form it doesn\'t read rather than taking it as empty', () => {
    const registry = new AgentRegistry();
    assert.deepEqual(registry.restore(null), { interrupted: [] });
    for (const [stored, says] of [
      [{ version: 9 }, /is version 9, which this framework doesn't read/],
      ['text', /holds a string, not an agent registry/],
      [{ version: 1, records: [], incarnations: {} }, /has no mail list/],
      [{ version: 1, records: [{ name: 'x' }], incarnations: {}, mail: [] }, /has a record \(1 of 1\) that has no incarnation/],
      [{ version: 1, records: [], incarnations: { x: '1' }, mail: [] }, /has an incarnation for "x" that is a string/],
    ] as const) {
      const fresh = new AgentRegistry();
      assert.throws(() => fresh.restore(stored), (error: Error) => error instanceof RegistryFormError && says.test(error.message));
      assert.deepEqual(fresh.list({ includeEnded: true }), [], 'nothing restored');
    }
    assert.throws(() => new AgentRegistry().restore(null, [{ name: 'x', incarnation: 1, lifetime: { kind: 'task' } }]),
      /has an ended record \(1 of the 1 read\) that hasn't ended/);
    registry.register(residentSpec('mira', { primary: true }));
    assert.equal(registry.get('mira')!.incarnation, 1);
  });
});

describe('AgentRegistry writes', () => {
  /** A registry whose writes can be made to fail. */
  function failing() {
    const state = { snapshot: null as RegistrySnapshot | null, ended: [] as AgentRecord[], failSnapshot: false, failEnded: false, failures: [] as string[], caughtUp: 0 };
    const registry = new AgentRegistry({
      persist: (snapshot) => {
        if (state.failSnapshot) throw new Error('EIO snapshot');
        state.snapshot = JSON.parse(JSON.stringify(snapshot));
      },
      appendEnded: (record) => {
        if (state.failEnded) throw new Error('EIO ended');
        state.ended.push(JSON.parse(JSON.stringify(record)));
      },
      onWriteFailed: (_error, what) => { state.failures.push(what); },
      onWriteCaughtUp: () => { state.caughtUp++; },
    });
    return { state, registry };
  }

  it('a transaction whose write fails changes nothing and throws the write\'s error', () => {
    const { state, registry } = failing();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('job', { spawnedBy: 'mira' }));
    const stored = JSON.stringify(state.snapshot);
    state.failSnapshot = true;
    assert.throws(() => registry.transact(() => registry.end('job', 'stopped')), /EIO snapshot/);
    assert.throws(() => registry.transact(() => registry.holdMail({ kind: 'message', from: registry.ref('mira'), to: 'job', content: [] })), /EIO snapshot/);
    assert.equal(registry.get('job')?.ended, undefined, 'job is still live');
    assert.deepEqual(registry.listMail(), [], 'nothing held');
    assert.equal(registry.inspect('job')?.incarnation, 1);
    assert.equal(JSON.stringify(state.snapshot), stored, 'nothing stored');
    assert.equal(state.ended.length, 0, 'no end logged');
    assert.deepEqual(state.failures, [], 'the caller hears it, so no failure is reported');

    state.failSnapshot = false;
    registry.transact(() => registry.end('job', 'stopped'));
    assert.equal(registry.inspect('job')?.ended?.reason, 'stopped');
    assert.deepEqual(state.ended.map((r) => r.name), ['job']);
  });

  it('a fact whose write fails is kept and reported, and the next write carries it', () => {
    const { state, registry } = failing();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('job', { spawnedBy: 'mira' }));
    state.failSnapshot = true;
    registry.end('job', 'completed');
    assert.equal(registry.inspect('job')?.ended?.reason, 'completed', 'kept in memory');
    assert.deepEqual(state.failures, ['snapshot']);
    assert.ok(state.snapshot!.records.some((r) => r.name === 'job'), 'the stored registry is behind');
    assert.equal(state.ended.length, 0, 'and the end isn\'t logged before its snapshot is stored');

    state.failSnapshot = false;
    registry.noteMessagePath('mira', 'mira');
    assert.equal(state.caughtUp, 1, 'the next write says it caught up');
    assert.ok(!state.snapshot!.records.some((r) => r.name === 'job'), 'and carries the end');
    assert.deepEqual(state.ended.map((r) => r.name), ['job']);
  });

  it('an end is stored with its snapshot, logged after it, and a restore logs what the log lacks', () => {
    const { state, registry } = failing();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('job', { spawnedBy: 'mira' }));
    state.failEnded = true;
    registry.transact(() => registry.end('job', 'stopped'));
    assert.deepEqual(state.failures, ['ended-log'], 'the append\'s failure is reported, not thrown: the end is stored');
    assert.deepEqual(state.snapshot!.unlogged?.map((r) => r.name), ['job'], 'the snapshot carries it');

    const { state: next, registry: restored } = failing();
    restored.restore(state.snapshot, state.ended);
    assert.equal(restored.inspect('job')?.ended?.reason, 'stopped');
    assert.deepEqual(next.ended.map((r) => r.name), ['job'], 'logged at the restore');
    restored.register(residentSpec('mira', { primary: true }));
    assert.equal(next.snapshot!.unlogged, undefined, 'and the next snapshot no longer carries it');

    // One the log already has isn't logged again.
    const { state: again, registry: twice } = failing();
    twice.restore(state.snapshot, next.ended);
    assert.deepEqual(again.ended, []);
    assert.equal(twice.list({ includeEnded: true }).filter((r) => r.name === 'job').length, 1);
  });
});
