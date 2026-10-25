export class AddressedMessages {
  static readonly LIMIT_PER_AGENT = 1000;

  private readonly byAgent = new Map<string, Map<string, AddressedEntry>>();

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

  stored(deferredId: string, storedId: string): void {
    for (const entries of this.byAgent.values()) {
      const entry = entries.get(deferredId);
      if (!entry) continue;
      entries.delete(deferredId);
      entries.set(storedId, { ...entry, stored: true });
    }
  }

  has(agent: string): boolean {
    return (this.byAgent.get(agent)?.size ?? 0) > 0;
  }

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

  withdraw(agent: string, id: string): string | undefined {
    const entries = this.byAgent.get(agent);
    const entry = entries?.get(id);
    if (!entries || !entry) return undefined;
    entries.delete(id);
    if (entries.size === 0) this.byAgent.delete(agent);
    return entry.name;
  }

  entriesOf(agent: string): Array<[string, AddressedEntry]> {
    return [...(this.byAgent.get(agent) ?? [])];
  }

  agentsWith(id: string): string[] {
    return [...this.byAgent].filter(([, entries]) => entries.has(id)).map(([agent]) => agent);
  }

  dropAgent(agent: string): string[] {
    const names = [...(this.byAgent.get(agent)?.values() ?? [])].map((entry) => entry.name);
    this.byAgent.delete(agent);
    return names;
  }
}

export interface AddressedEntry {
  name: string;
  storedIn: string;
  stored: boolean;
}
