/**
 * The framework's record of addressed messages not yet delivered, for fleet
 * telemetry: a message stored, or held for storage, with a wake asked for it,
 * until a request of the agent it's addressed to carries it.
 *
 * Each entry is named by the id its arrival named (`message:added`'s
 * `messageId`, or its `deferredId` for a write deferred at arrival), and is
 * found again by the id it's stored under once it is. It keeps the agent
 * whose window it's stored in, which a subconscious reading a resident's
 * diverted traffic doesn't share. It lives in memory: a restart loses it.
 * Each agent holds at most LIMIT_PER_AGENT entries; past that a message isn't
 * recorded, and its `message:addressed` says so: each time its wake is
 * asked, since nothing past the bound is remembered.
 */
export class AddressedMessages {
  static readonly LIMIT_PER_AGENT = 1000;

  /** Per agent it's addressed to: the id an entry is found by now (its
   *  stored id, or its deferred id until it's stored) to its name and the
   *  agent whose window holds it. */
  private readonly byAgent = new Map<string, Map<string, AddressedEntry>>();

  /** Record `id` for `agent`: a stored message's id in `storedIn`'s store,
   *  or a held write's deferred id (`stored` false), named `name`, the id its
   *  arrival named (its deferred id for a held write noted after it was
   *  stored). `present` when it's recorded for the agent already, and `full`
   *  when the agent's record is, so the message isn't recorded. */
  add(agent: string, id: string, storedIn: string, stored: boolean, name: string = id): 'added' | 'present' | 'full' {
    let entries = this.byAgent.get(agent);
    if (entries?.has(id)) return 'present';
    if ((entries?.size ?? 0) >= AddressedMessages.LIMIT_PER_AGENT) return 'full';
    if (!entries) {
      entries = new Map();
      this.byAgent.set(agent, entries);
    }
    entries.set(id, { name, storedIn, stored });
    return 'added';
  }

  /** A write held under `deferredId` was stored as `storedId`: each entry for
   *  it is found by its stored id from now on, and keeps its name. */
  stored(deferredId: string, storedId: string): void {
    for (const entries of this.byAgent.values()) {
      const entry = entries.get(deferredId);
      if (!entry) continue;
      entries.delete(deferredId);
      entries.set(storedId, { ...entry, stored: true });
    }
  }

  /** Whether `agent` has entries, so a caller can skip finding which ones a
   *  request carries. */
  has(agent: string): boolean {
    return (this.byAgent.get(agent)?.size ?? 0) > 0;
  }

  /** Take out the entries of `agent` a request carries, given the stored ids
   *  it carries: the names of those taken, in the order given. */
  deliver(agent: string, carried: Iterable<string>): string[] {
    const entries = this.byAgent.get(agent);
    if (!entries || entries.size === 0) return [];
    const named: string[] = [];
    for (const id of carried) {
      const entry = entries.get(id);
      if (!entry) continue;
      entries.delete(id);
      named.push(entry.name);
    }
    if (entries.size === 0) this.byAgent.delete(agent);
    return named;
  }

  /** Take out the entry of `agent` found by `id`: its name, or undefined
   *  when there's none. */
  withdraw(agent: string, id: string): string | undefined {
    const entries = this.byAgent.get(agent);
    const entry = entries?.get(id);
    if (!entries || !entry) return undefined;
    entries.delete(id);
    if (entries.size === 0) this.byAgent.delete(agent);
    return entry.name;
  }

  /** Every entry of `agent`, by the id it's found by now. */
  entriesOf(agent: string): Array<[string, AddressedEntry]> {
    return [...(this.byAgent.get(agent) ?? [])];
  }

  /** Every agent with entries for `id` (found by it now). */
  agentsWith(id: string): string[] {
    return [...this.byAgent].filter(([, entries]) => entries.has(id)).map(([agent]) => agent);
  }

  /** Take out every entry of `agent`: their names. */
  dropAgent(agent: string): string[] {
    const names = [...(this.byAgent.get(agent)?.values() ?? [])].map((entry) => entry.name);
    this.byAgent.delete(agent);
    return names;
  }
}

/** One addressed message waiting for its agent: its name (the id its arrival
 *  named), the agent whose window holds it, and whether it's stored there
 *  yet, or still a held write found by its deferred id. */
export interface AddressedEntry {
  name: string;
  storedIn: string;
  stored: boolean;
}
