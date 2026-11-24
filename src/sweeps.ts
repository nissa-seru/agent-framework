import type {
  SummaryDropCost,
  SummaryLevelCount,
  SweepChange,
  SweepEntry,
  SweepFailure,
  SweepPass,
  SweepPassReport,
  SweepTake,
} from '@animalabs/context-manager';

/** The old summaries of one agent's strategy, at each level (ContextManager.oldSummaryCost). */
export interface AgentOldSummaries {
  agent: string;
  summaries: SummaryLevelCount[];
}

/** What a pass would drop from one agent's strategy itself, where it joins a long note (ContextManager.showSweep's writeDrops). */
export interface AgentWriteDrops {
  agent: string;
  drops: SummaryDropCost;
}

/**
 * What a sweep would change on the open branch (AgentFramework.showSweep).
 * Never the old text.
 */
export interface FrameworkSweepShow {
  name: string;
  line: string;
  /** Each body that a pass would rewrite, once, with the live agents that read it: in a window, through their view, or as a reader fork's framing. */
  changes: Array<SweepChange & { agents: string[] }>;
  /** Each body that a pass would not rewrite, and why. */
  failures: SweepFailure[];
  /** The summaries that each live agent's strategy would keep as old once a pass rewrote the changes. */
  oldSummaries: AgentOldSummaries[];
  /** What a pass would drop from each live agent's strategy itself, where it joins a long note: never counted in oldSummaries too. */
  writeDrops: AgentWriteDrops[];
}

/** Where a sweep stands on the open branch (AgentFramework.sweepReceipt). Never the old text. */
export interface FrameworkSweepReceipt {
  name: string;
  /** The store's newest take of the sweep, or null: never taken. */
  take: SweepTake | null;
  /** Whether every live agent's slot on the open branch finished that take. */
  finished: boolean;
  /** Each pass on the open branch, with the bodies that it listed. */
  passes: SweepPass[];
  oldSummaries: AgentOldSummaries[];
}

/**
 * One live agent's pass, as its context manager reported it. Its report's
 * `dropped` counts the summaries that agent's strategy held as its own pass
 * began and no longer holds as it ends. Where agents hold one note, an
 * earlier agent's pass in the same take can remove the note's later shards
 * first, and the later agent's strategy then lets go of the summaries over
 * them before its own pass begins. Those are gone, and no report counts
 * them, so such a report can count less than the agent's `writeDrops` in
 * the show.
 */
export interface AgentSweepPass {
  agent: string;
  report: SweepPassReport;
}

/** A live agent's pass that threw before it reported, with what it threw. What it owes stays owed. */
export interface SweepPassThrew {
  agent: string;
  error: string;
}

/**
 * How a sweep's write ended (AgentFramework.takeSweep). `finished`: every
 * live agent's slot on the open branch finished the newest take. `failed`:
 * a slot did not: `failed` names each body that a pass reported not
 * rewritten, and `threw` each context whose pass threw before it reported.
 * `held`: where there was a take to apply, an agent's turn was alive, or
 * another operator's act held the store, so nothing was applied: the store
 * took the sweep (or had taken it), and the next start or branch move
 * applies it, as does the same call between turns.
 */
export type FrameworkSweepWrite =
  | { outcome: 'finished'; name: string; took: SweepTake | null; passes: AgentSweepPass[]; threw: SweepPassThrew[]; oldSummaries: AgentOldSummaries[] }
  | { outcome: 'failed'; name: string; took: SweepTake | null; passes: AgentSweepPass[]; failed: SweepFailure[]; threw: SweepPassThrew[]; oldSummaries: AgentOldSummaries[] }
  | { outcome: 'held'; name: string; took: SweepTake | null; refusal: string };

export function sweepEntriesByName(entries: readonly SweepEntry[]): ReadonlyMap<string, SweepEntry> {
  const byName = new Map<string, SweepEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) throw new Error(`Two sweep entries are named "${entry.name}": a sweep's name names one entry`);
    byName.set(entry.name, entry);
  }
  return byName;
}
