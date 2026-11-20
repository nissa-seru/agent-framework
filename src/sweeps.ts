import type {
  OldSummaryLevel,
  SweepChange,
  SweepEntry,
  SweepFailure,
  SweepPass,
  SweepPassReport,
  SweepTake,
} from '@animalabs/context-manager';
import { UNSTICK_FIX_11_16 } from './sweep-unstick-fix-11-16.js';

const FRAMEWORK_SWEEPS: readonly SweepEntry[] = [UNSTICK_FIX_11_16];

/** The old summaries of one agent's strategy, at each level (ContextManager.oldSummaryCost). */
export interface AgentOldSummaries {
  agent: string;
  summaries: OldSummaryLevel[];
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

/** One live agent's pass, as its context manager reported it. */
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

export function sweepEntriesByName(hostEntries: readonly SweepEntry[]): ReadonlyMap<string, SweepEntry> {
  const byName = new Map<string, SweepEntry>(FRAMEWORK_SWEEPS.map((entry) => [entry.name, entry]));
  for (const entry of hostEntries) {
    if (FRAMEWORK_SWEEPS.some((own) => own.name === entry.name)) {
      throw new Error(`The framework has a sweep entry named "${entry.name}": a host's entry takes another name`);
    }
    if (byName.has(entry.name)) throw new Error(`Two sweep entries are named "${entry.name}": a sweep's name names one entry`);
    byName.set(entry.name, entry);
  }
  return byName;
}
