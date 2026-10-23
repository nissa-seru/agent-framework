/**
 * AgentRegistry — the one place that knows which agents exist, what they
 * are for, how they relate and what ends them.
 *
 * Pure bookkeeping: it never touches a stream, a context manager or a
 * channel. Lifecycle methods return what changed (who ended, who was
 * orphaned, which mail became deliverable) and the framework performs the
 * side effects. That split keeps every rule here testable without a store
 * and keeps the framework from re-deriving policy at each call site.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentEndReason,
  AgentName,
  AgentRecord,
  AgentRef,
  AgentSpec,
  EndOutcome,
  HeldMail,
  RegistrySnapshot,
} from './types.js';

/** Thrown for a spec the registry refuses to load. */
export class AgentSpecError extends Error {
  constructor(agent: string, problem: string) {
    super(`agent "${agent}": ${problem}`);
    this.name = 'AgentSpecError';
  }
}

export interface AgentRegistryOptions {
  now?: () => number;
  /**
   * Called after every durable mutation with the state to persist. A write
   * that throws isn't taken as done: see {@link AgentRegistry.transact} for
   * a change a caller asked for, and `onWriteFailed` for the rest.
   */
  persist?: (snapshot: RegistrySnapshot) => void;
  /**
   * Called once per ended record, after a snapshot that carries it (its
   * `unlogged`) has been persisted. Ended records are append-only history,
   * kept out of the snapshot's records so a mutation never rewrites them; a
   * record whose append throws stays in `unlogged` and is appended again
   * with the next write.
   */
  appendEnded?: (record: AgentRecord) => void;
  /**
   * A write of a fact that had already happened failed: an ended run, a
   * landed release, a restart's interruptions. Nothing can undo the fact, so
   * the registry keeps it in memory, and its next write carries it. Called
   * for each such failure, with what failed to be written.
   */
  onWriteFailed?: (error: unknown, what: 'snapshot' | 'ended-log') => void;
  /** A write succeeded after a run of failures (onWriteFailed). */
  onWriteCaughtUp?: () => void;
  /** How many ended records stay inspectable in memory (oldest dropped first). */
  endedRetention?: number;
}

/** A stored registry, or ended-log record, in a form this registry doesn't read. */
export class RegistryFormError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'RegistryFormError';
  }
}

/** The registry's state, held whole while a transaction can still undo it. */
interface RegistryState {
  live: Array<[AgentName, AgentRecord]>;
  ended: AgentRecord[];
  awaiting: Array<[AgentName, AgentRecord]>;
  incarnations: Array<[AgentName, number]>;
  mail: HeldMail[];
  unlogged: AgentRecord[];
}

/** What a restore found that the previous process left unfinished. */
export interface RestoreOutcome {
  /** Non-persistent agents that were live when the previous process stopped. */
  interrupted: AgentRecord[];
}

/** What boot reconciliation concluded once configuration was applied. */
export interface ReconcileOutcome {
  /** Persistent agents the previous process ran that this configuration no longer declares. */
  unconfigured: EndOutcome[];
}

const DEFAULT_ENDED_RETENTION = 256;

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** An ended record's identity: one end per incarnation of a name. */
const endedKey = (record: AgentRecord): string => `${record.name}#${record.incarnation}`;

function kindOf(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** What's wrong with a stored agent record, or null when restore can read it. */
function recordProblem(raw: unknown, ended: boolean): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `is ${kindOf(raw)}, not an agent record`;
  const record = raw as Partial<AgentRecord>;
  if (typeof record.name !== 'string' || record.name === '') return 'has no name';
  if (typeof record.incarnation !== 'number') return `has no incarnation (agent "${record.name}")`;
  if (!record.lifetime || typeof record.lifetime !== 'object' || typeof record.lifetime.kind !== 'string') {
    return `has no lifetime (agent "${record.name}")`;
  }
  if (ended && (!record.ended || typeof record.ended !== 'object')) return `hasn't ended (agent "${record.name}")`;
  return null;
}

/**
 * Check records read from the ended log before any is taken: each must be an
 * ended agent record. Throws a {@link RegistryFormError} naming the first
 * that isn't.
 */
export function checkEndedRecords(records: readonly unknown[]): void {
  records.forEach((raw, index) => {
    const problem = recordProblem(raw, true);
    if (problem) throw new RegistryFormError(`has an ended record (${index + 1} of the ${records.length} read) that ${problem}`);
  });
}

/** What's wrong with a stored held item, or null when restore can read it. */
function mailProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `is ${kindOf(raw)}, not held mail`;
  const item = raw as Partial<HeldMail>;
  if (typeof item.id !== 'string') return 'has no id';
  if (typeof item.to !== 'string') return `has no recipient (mail ${item.id})`;
  if (!item.from || typeof item.from !== 'object' || typeof item.from.agent !== 'string') return `has no sender (mail ${item.id})`;
  if (!Array.isArray(item.content)) return `has no content (mail ${item.id})`;
  return null;
}

export class AgentRegistry {
  private readonly live = new Map<AgentName, AgentRecord>();
  /** Ended records, oldest first. */
  private ended: AgentRecord[] = [];
  /** Persistent records from the previous process, not yet re-declared. */
  private readonly awaiting = new Map<AgentName, AgentRecord>();
  private readonly incarnations = new Map<AgentName, number>();
  private mail: HeldMail[] = [];
  /** Ended records not yet in the ended log, oldest first. Each snapshot
   *  carries them, so an end is stored with the snapshot that records it. */
  private unlogged: AgentRecord[] = [];
  /** Open while a transaction's change is being made: writes wait for it. */
  private transaction: { dirty: boolean } | null = null;
  /** A write of a fact failed, and none has succeeded since. */
  private behind = false;
  private readonly now: () => number;
  private readonly persistFn?: (snapshot: RegistrySnapshot) => void;
  private readonly appendEndedFn?: (record: AgentRecord) => void;
  private readonly onWriteFailed?: (error: unknown, what: 'snapshot' | 'ended-log') => void;
  private readonly onWriteCaughtUp?: () => void;
  private readonly endedRetention: number;

  constructor(options: AgentRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persistFn = options.persist;
    this.appendEndedFn = options.appendEnded;
    this.onWriteFailed = options.onWriteFailed;
    this.onWriteCaughtUp = options.onWriteCaughtUp;
    this.endedRetention = options.endedRetention ?? DEFAULT_ENDED_RETENTION;
  }

  /**
   * Make a change a caller asked for, such as an agent stopped, a message
   * sent or a result held, so that it's stored or not made at all. The
   * registry writes once, after `fn`; a write that throws puts the registry
   * back as it was before `fn` and throws the write's error, so the call
   * fails and changes nothing. An `fn` that throws does the same with its
   * own error. A transaction inside another is part of it.
   */
  transact<T>(fn: () => T): T {
    if (this.transaction) return fn();
    const before = this.capture();
    const transaction = (this.transaction = { dirty: false });
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.transaction = null;
      this.restoreState(before);
      throw error;
    }
    this.transaction = null;
    if (!transaction.dirty || !this.persistFn) return result;
    try {
      this.persistFn(this.snapshot());
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
    this.caughtUp();
    this.logEnded();
    return result;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Admit an agent. Refuses a spec that breaks a registry invariant — an
   * unbounded task, a second default-delivery owner, a relationship that
   * names nobody — so a malformed agent fails at load, not mid-run.
   *
   * `resume` admits a new incarnation of an identity that ended: where its
   * context came from is then history, so the context source no longer has
   * to be live. Who it reports to still does.
   */
  register(spec: AgentSpec, options: { resume?: boolean } = {}): AgentRecord {
    this.validate(spec, options.resume === true);
    const previous = this.awaiting.get(spec.name);
    this.awaiting.delete(spec.name);

    const incarnation = (this.incarnations.get(spec.name) ?? 0) + 1;
    this.incarnations.set(spec.name, incarnation);

    const record: AgentRecord = {
      name: spec.name,
      kind: spec.kind,
      ...(spec.model ? { model: spec.model } : {}),
      incarnation,
      roles: { ...spec.roles },
      lifetime: { ...spec.lifetime },
      ...(spec.activation ? { activation: { ...spec.activation } } : {}),
      onParentEnd: spec.onParentEnd ?? 'orphan',
      relationships: {
        ...(spec.spawnedBy ? { spawnedBy: spec.spawnedBy } : {}),
        observes: (spec.observes ?? []).map((edge) => ({ ...edge })),
        // Explicit message paths accumulate over an identity's life.
        messagePeers: previous ? [...previous.relationships.messagePeers] : [],
        ...(spec.resultTo ? { resultTo: { ...spec.resultTo } } : {}),
      },
      ...(spec.inherit ? { inherit: clone(spec.inherit) } : {}),
      ...(spec.selfParticipants?.length ? { selfParticipants: [...spec.selfParticipants] } : {}),
      ...(spec.presentAs ? { presentAs: spec.presentAs } : {}),
      ...(spec.homeChannel ? { homeChannel: spec.homeChannel } : {}),
      readsSharedSlot: spec.readsSharedSlot ?? false,
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.metadata ? { metadata: clone(spec.metadata) } : {}),
      createdAt: previous?.createdAt ?? this.now(),
    };
    this.live.set(spec.name, record);
    this.persist();
    return record;
  }

  private validate(spec: AgentSpec, resume = false): void {
    const fail = (problem: string): never => {
      throw new AgentSpecError(spec.name || '(unnamed)', problem);
    };
    if (!spec.name) fail('a name is required');
    if (this.live.has(spec.name)) fail('is already registered');

    if (spec.roles.defaultDelivery) {
      const owner = this.primary();
      if (owner) fail(`default delivery already belongs to "${owner}"; exactly one agent owns it`);
    }

    const lifetime = spec.lifetime;
    if (lifetime.kind === 'task') {
      const bounded =
        (lifetime.deadlineMs !== undefined && lifetime.deadlineMs > 0) ||
        (lifetime.idleTimeoutMs !== undefined && lifetime.idleTimeoutMs > 0);
      if (!bounded) fail('a task lifetime needs a deadline or an idle timeout; every task agent must end');
    } else if (lifetime.kind === 'idle') {
      if (!(lifetime.idleTtlMs > 0)) fail('an idle lifetime needs a positive idleTtlMs');
    }

    if (spec.spawnedBy !== undefined) {
      if (spec.spawnedBy === spec.name) fail('cannot be spawned by itself');
      if (!this.live.has(spec.spawnedBy)) fail(`spawner "${spec.spawnedBy}" is not a registered agent`);
    } else if (spec.onParentEnd === 'end') {
      fail('onParentEnd "end" needs a spawnedBy relationship');
    }
    if (spec.resultTo && !this.live.has(spec.resultTo.to)) {
      fail(`result recipient "${spec.resultTo.to}" is not a registered agent`);
    }
    if (spec.inherit && !resume && !this.live.has(spec.inherit.from)) {
      fail(`context source "${spec.inherit.from}" is not a registered agent`);
    }
    for (const edge of spec.observes ?? []) {
      if (edge.agent !== undefined && !this.live.has(edge.agent)) {
        fail(`observed agent "${edge.agent}" is not a registered agent`);
      }
    }
  }

  // ==========================================================================
  // Discovery
  // ==========================================================================

  /** A live agent's record. */
  get(name: AgentName): AgentRecord | undefined {
    return this.live.get(name);
  }

  has(name: AgentName): boolean {
    return this.live.has(name);
  }

  /** The live record, else the most recent ended one with that name. */
  inspect(name: AgentName): AgentRecord | undefined {
    const live = this.live.get(name);
    if (live) return live;
    for (let i = this.ended.length - 1; i >= 0; i--) {
      if (this.ended[i]!.name === name) return this.ended[i];
    }
    return undefined;
  }

  /** Flat list of agents — the discovery surface. Ended ones on request. */
  list(options: { includeEnded?: boolean } = {}): AgentRecord[] {
    const live = [...this.live.values()];
    return options.includeEnded ? [...this.ended, ...live] : live;
  }

  /** Provenance stamp for a live agent (or its last incarnation). */
  ref(name: AgentName): AgentRef {
    const record = this.inspect(name);
    return { agent: name, incarnation: record?.incarnation ?? this.incarnations.get(name) ?? 0 };
  }

  // ==========================================================================
  // Role queries — the positive replacements for exclusion filters
  // ==========================================================================

  /** The agent that owns default delivery, if any. */
  primary(): AgentName | null {
    for (const record of this.live.values()) {
      if (record.roles.defaultDelivery) return record.name;
    }
    return null;
  }

  /** Recipients of untargeted inbound, in registration order. */
  untargetedRecipients(): AgentName[] {
    return this.namesWhere((r) => r.roles.receivesUntargeted);
  }

  /** Recipients of host-wide gate fan-out, in registration order. */
  gateRecipients(): AgentName[] {
    return this.namesWhere((r) => r.roles.receivesGateWakes);
  }

  ownsProviderScheduling(name: AgentName): boolean {
    return this.live.get(name)?.roles.ownsProviderScheduling === true;
  }

  /** Agents reading the residents' shared message slot. */
  sharedSlotReaders(): AgentName[] {
    return this.namesWhere((r) => r.readsSharedSlot);
  }

  readsSharedSlot(name: AgentName): boolean {
    return this.live.get(name)?.readsSharedSlot === true;
  }

  /** The channel an agent is bound to, if it has one. */
  homeChannel(name: AgentName): string | undefined {
    return this.live.get(name)?.homeChannel;
  }

  /** Live agents of one preset label. Discovery only — see {@link AgentKind}. */
  ofKind(kind: string): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.kind === kind);
  }

  private namesWhere(predicate: (record: AgentRecord) => boolean): AgentName[] {
    const names: AgentName[] = [];
    for (const record of this.live.values()) if (predicate(record)) names.push(record.name);
    return names;
  }

  // ==========================================================================
  // Relationships
  // ==========================================================================

  /** Live agents this one spawned. */
  children(name: AgentName): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.relationships.spawnedBy === name && !r.orphaned);
  }

  /** Live spawn ancestors, nearest first. */
  ancestors(name: AgentName): AgentName[] {
    const chain: AgentName[] = [];
    const seen = new Set<AgentName>([name]);
    let cursor = this.live.get(name)?.relationships.spawnedBy;
    while (cursor && !seen.has(cursor) && this.live.has(cursor)) {
      chain.push(cursor);
      seen.add(cursor);
      cursor = this.live.get(cursor)?.relationships.spawnedBy;
    }
    return chain;
  }

  /** Live agents whose completed work returns to `name`. */
  resultSources(name: AgentName): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.relationships.resultTo?.to === name);
  }

  /** Record that `from` used an explicit message path to `to`. */
  noteMessagePath(from: AgentName, to: AgentName): void {
    const record = this.live.get(from);
    if (!record || record.relationships.messagePeers.includes(to)) return;
    record.relationships.messagePeers.push(to);
    this.persist();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * End an agent identity. Attention tenants it spawned end with it; task
   * work it spawned is orphaned, with reparenting candidates. Result routes
   * that pointed at it are left in place — delivery holds the mail instead
   * of dropping it, so a later adoption can still receive the result.
   */
  end(name: AgentName, reason: AgentEndReason, by?: string): EndOutcome | null {
    const record = this.live.get(name);
    if (!record) return null;
    const outcome = this.endRecursive(record, reason, by);
    this.persist();
    return outcome;
  }

  private endRecursive(record: AgentRecord, reason: AgentEndReason, by?: string): EndOutcome {
    // Candidates are computed before removal so the chain is still walkable.
    const adopters = this.adoptionCandidates(record);

    this.live.delete(record.name);
    this.recordEnded(record, reason, by);

    const cascaded: AgentRecord[] = [];
    const orphaned: EndOutcome['orphaned'] = [];
    const formerParent: AgentRef = { agent: record.name, incarnation: record.incarnation };
    for (const child of [...this.live.values()]) {
      if (child.relationships.spawnedBy !== record.name || child.orphaned) continue;
      if (!this.live.has(child.name)) continue; // ended by an earlier cascade
      if (child.onParentEnd === 'end') {
        const inner = this.endRecursive(child, 'parent-ended', record.name);
        cascaded.push(...inner.cascaded, inner.ended);
        orphaned.push(...inner.orphaned);
      } else {
        const candidates = adopters.filter((candidate) => candidate !== child.name);
        child.orphaned = { since: this.now(), formerParent, reason, candidates };
        orphaned.push({ record: child, candidates });
      }
    }
    return { ended: record, cascaded, orphaned };
  }

  /** Who could take over an ending agent's children: nearest live ancestor, then the primary. */
  private adoptionCandidates(record: AgentRecord): AgentName[] {
    const candidates = this.ancestors(record.name);
    const primary = this.primary();
    if (primary && primary !== record.name && !candidates.includes(primary)) candidates.push(primary);
    return candidates;
  }

  /**
   * Give an agent a new spawner. Clears orphan state. A result route whose
   * recipient is gone follows the new parent, and mail the agent already
   * produced for the lost recipient is re-addressed and returned so the
   * caller can deliver it.
   */
  reparent(name: AgentName, newParent: AgentName): { record: AgentRecord; deliverable: HeldMail[] } {
    const record = this.live.get(name);
    if (!record) throw new AgentSpecError(name, 'is not a registered agent');
    if (!this.live.has(newParent)) throw new AgentSpecError(name, `new parent "${newParent}" is not a registered agent`);
    if (newParent === name) throw new AgentSpecError(name, 'cannot be its own parent');
    if (this.ancestors(newParent).includes(name)) {
      throw new AgentSpecError(name, `"${newParent}" descends from it; reparenting would form a cycle`);
    }
    record.relationships.spawnedBy = newParent;
    delete record.orphaned;

    const route = record.relationships.resultTo;
    if (route && !this.live.has(route.to)) route.to = newParent;

    const deliverable: HeldMail[] = [];
    for (const item of this.mail) {
      if (item.from.agent === name && !this.live.has(item.to)) {
        item.to = newParent;
        item.heldBecause = 'undelivered';
        deliverable.push(item);
      }
    }
    this.persist();
    return { record, deliverable };
  }

  // ==========================================================================
  // Held mail
  // ==========================================================================

  /** Record a communication durably BEFORE attempting delivery. */
  holdMail(mail: Omit<HeldMail, 'id' | 'createdAt'> & { id?: string }): HeldMail {
    const item: HeldMail = {
      ...mail,
      id: mail.id ?? randomUUID(),
      createdAt: this.now(),
      content: clone(mail.content),
    };
    this.mail.push(item);
    this.persist();
    return item;
  }

  /** Delivery confirmed: forget the held copy. */
  releaseMail(id: string): void {
    const before = this.mail.length;
    this.mail = this.mail.filter((item) => item.id !== id);
    if (this.mail.length !== before) this.persist();
  }

  /** Mark why an item is still held (delivery attempted and not possible yet). */
  markMailHeld(id: string, because: NonNullable<HeldMail['heldBecause']>): void {
    const item = this.mail.find((candidate) => candidate.id === id);
    if (!item || item.heldBecause === because) return;
    item.heldBecause = because;
    this.persist();
  }

  listMail(filter: { to?: AgentName; from?: AgentName } = {}): HeldMail[] {
    return this.mail.filter(
      (item) =>
        (filter.to === undefined || item.to === filter.to) &&
        (filter.from === undefined || item.from.agent === filter.from),
    );
  }

  // ==========================================================================
  // Persistence and restart
  // ==========================================================================

  snapshot(): RegistrySnapshot {
    const records = [...this.awaiting.values(), ...this.live.values()].map((record) => clone(record));
    // Counters are kept for identities that can still be referred to: live
    // agents, persistent agents awaiting re-declaration, and ended agents
    // still in retention. A single-use name that has aged out restarts at 1.
    const referable = new Set<AgentName>([
      ...this.live.keys(),
      ...this.awaiting.keys(),
      ...this.ended.map((record) => record.name),
    ]);
    const incarnations: Record<AgentName, number> = {};
    for (const [name, value] of this.incarnations) if (referable.has(name)) incarnations[name] = value;
    return {
      version: 1,
      records,
      incarnations,
      mail: clone(this.mail),
      ...(this.unlogged.length > 0 ? { unlogged: clone(this.unlogged) } : {}),
    };
  }

  /**
   * Load what the previous process persisted. Restart behaviour follows
   * from lifetime: a persistent agent waits to be re-declared by
   * configuration (see {@link reconcile}); every other agent that was live
   * is ended here as interrupted, and returned so its result recipient can
   * be told. Held mail is kept for redelivery.
   *
   * `endedHistory` is the tail of the ended-record log, oldest first.
   *
   * Nothing stored (`null` or `undefined`) is an empty registry. A snapshot
   * or ended record in any form this registry doesn't read throws a
   * {@link RegistryFormError} saying what's wrong, and nothing is restored:
   * taken as empty, the registry's next write would replace what was
   * stored, held mail included. Ended records the snapshot carries that the
   * log doesn't have yet are taken into history and appended to the log
   * with the next write.
   */
  restore(snapshot: unknown, endedHistory: readonly unknown[] = []): RestoreOutcome {
    const checked = this.checkStored(snapshot, endedHistory);
    const interrupted: AgentRecord[] = [];
    for (const record of checked.ended.slice(-this.endedRetention)) this.ended.push(clone(record));
    if (!checked.snapshot) return { interrupted };
    const stored = checked.snapshot;

    for (const [name, value] of Object.entries(stored.incarnations)) this.incarnations.set(name, value);
    this.mail = clone(stored.mail);

    const logged = new Set(checked.ended.map(endedKey));
    for (const raw of this.appendEndedFn ? stored.unlogged ?? [] : []) {
      if (logged.has(endedKey(raw))) continue;
      const record = clone(raw);
      this.ended.push(record);
      this.unlogged.push(clone(record));
    }
    if (this.ended.length > this.endedRetention) this.ended.splice(0, this.ended.length - this.endedRetention);

    for (const raw of stored.records) {
      const record = clone(raw);
      if (record.ended) continue; // history lives in the ended log
      if (record.lifetime.kind === 'persistent') {
        this.awaiting.set(record.name, record);
        continue;
      }
      this.recordEnded(record, 'host-restart');
      interrupted.push(record);
    }
    if (interrupted.length > 0 || this.unlogged.length > 0) this.persist();
    return { interrupted };
  }

  /** Check what restore was handed, before any of it is taken. */
  private checkStored(
    snapshot: unknown,
    endedHistory: readonly unknown[],
  ): { snapshot: RegistrySnapshot | null; ended: AgentRecord[] } {
    checkEndedRecords(endedHistory);
    const ended = endedHistory as AgentRecord[];
    if (snapshot === null || snapshot === undefined) return { snapshot: null, ended };
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new RegistryFormError(`holds ${kindOf(snapshot)}, not an agent registry`);
    }
    const stored = snapshot as Partial<RegistrySnapshot> & { version?: unknown };
    if (stored.version !== 1) {
      throw new RegistryFormError(
        stored.version === undefined
          ? 'has no version, so it is not an agent registry this framework wrote'
          : `is version ${JSON.stringify(stored.version)}, which this framework doesn't read (it reads version 1)`,
      );
    }
    const notA = (field: string, value: unknown, want: string) => new RegistryFormError(
      value === undefined ? `has no ${field}` : `has ${field} that is ${kindOf(value)}, not ${want}`);
    if (!Array.isArray(stored.records)) throw notA('records list', stored.records, 'a list');
    if (!Array.isArray(stored.mail)) throw notA('mail list', stored.mail, 'a list');
    if (!stored.incarnations || typeof stored.incarnations !== 'object' || Array.isArray(stored.incarnations)) {
      throw notA('incarnations map', stored.incarnations, 'a map');
    }
    for (const [name, value] of Object.entries(stored.incarnations)) {
      if (typeof value !== 'number') throw new RegistryFormError(`has an incarnation for "${name}" that is ${kindOf(value)}, not a number`);
    }
    if (stored.unlogged !== undefined && !Array.isArray(stored.unlogged)) throw notA('unlogged list', stored.unlogged, 'a list');
    stored.records.forEach((raw, index) => {
      const problem = recordProblem(raw, false);
      if (problem) throw new RegistryFormError(`has a record (${index + 1} of ${stored.records!.length}) that ${problem}`);
    });
    stored.unlogged?.forEach((raw, index) => {
      const problem = recordProblem(raw, true);
      if (problem) throw new RegistryFormError(`has an unlogged ended record (${index + 1}) that ${problem}`);
    });
    stored.mail.forEach((raw, index) => {
      const problem = mailProblem(raw);
      if (problem) throw new RegistryFormError(`has held mail (${index + 1} of ${stored.mail!.length}) that ${problem}`);
    });
    return { snapshot: stored as RegistrySnapshot, ended };
  }

  /**
   * Call once configuration has declared its agents. A persistent agent the
   * previous process ran but this configuration omits is ended, with the
   * usual consequences for what it spawned.
   */
  reconcile(): ReconcileOutcome {
    const unconfigured: EndOutcome[] = [];
    for (const record of [...this.awaiting.values()]) {
      this.awaiting.delete(record.name);
      this.recordEnded(record, 'not-configured');
      const formerParent: AgentRef = { agent: record.name, incarnation: record.incarnation };
      const orphaned: EndOutcome['orphaned'] = [];
      const primary = this.primary();
      for (const child of this.live.values()) {
        if (child.relationships.spawnedBy !== record.name || child.orphaned) continue;
        const candidates = primary && primary !== child.name ? [primary] : [];
        child.orphaned = { since: this.now(), formerParent, reason: 'not-configured', candidates };
        orphaned.push({ record: child, candidates });
      }
      unconfigured.push({ ended: record, cascaded: [], orphaned });
    }
    if (unconfigured.length > 0) this.persist();
    return { unconfigured };
  }

  private recordEnded(record: AgentRecord, reason: AgentEndReason, by?: string): void {
    record.ended = { at: this.now(), reason, ...(by ? { by } : {}) };
    this.ended.push(record);
    if (this.ended.length > this.endedRetention) {
      this.ended.splice(0, this.ended.length - this.endedRetention);
    }
    // Logged after the snapshot that carries it is stored (logEnded).
    if (this.appendEndedFn) this.unlogged.push(clone(record));
  }

  /**
   * Store the registry after a change. Inside a transaction the write waits
   * for the transaction to end. Otherwise the change records a fact that
   * has already happened, so a write that fails keeps it in memory, says so
   * (onWriteFailed), and leaves it to the next write, which stores the
   * registry whole.
   */
  private persist(): void {
    if (this.transaction) {
      this.transaction.dirty = true;
      return;
    }
    if (!this.persistFn) return;
    try {
      this.persistFn(this.snapshot());
    } catch (error) {
      this.behind = true;
      this.onWriteFailed ? this.onWriteFailed(error, 'snapshot') : console.error('[dendrite] failed to store the agent registry:', error);
      return;
    }
    this.caughtUp();
    this.logEnded();
  }

  /** Append the ended records a stored snapshot carries to the ended log, oldest first. */
  private logEnded(): void {
    if (!this.appendEndedFn) return;
    while (this.unlogged.length > 0) {
      try {
        this.appendEndedFn(clone(this.unlogged[0]!));
      } catch (error) {
        this.behind = true;
        this.onWriteFailed ? this.onWriteFailed(error, 'ended-log') : console.error('[dendrite] failed to append an ended agent record:', error);
        return;
      }
      this.unlogged.shift();
    }
  }

  private caughtUp(): void {
    if (!this.behind) return;
    this.behind = false;
    this.onWriteCaughtUp?.();
  }

  /** What a transaction can change, kept to put back. Live and awaiting
   *  records, and held mail, are changed in place, so they're copied whole;
   *  ended records aren't changed once ended, so their lists are copied
   *  shallow. */
  private capture(): RegistryState {
    return {
      live: clone([...this.live]),
      ended: [...this.ended],
      awaiting: clone([...this.awaiting]),
      incarnations: [...this.incarnations],
      mail: clone(this.mail),
      unlogged: [...this.unlogged],
    };
  }

  private restoreState(state: RegistryState): void {
    this.live.clear();
    for (const [name, record] of state.live) this.live.set(name, record);
    this.ended = state.ended;
    this.awaiting.clear();
    for (const [name, record] of state.awaiting) this.awaiting.set(name, record);
    this.incarnations.clear();
    for (const [name, value] of state.incarnations) this.incarnations.set(name, value);
    this.mail = state.mail;
    this.unlogged = state.unlogged;
  }
}
