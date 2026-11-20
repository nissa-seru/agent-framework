import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { ContextManager, sweepsApplied } from '@animalabs/context-manager';
import type { ContextStrategy, MessageId, StoredContentBlock, SweepEntry } from '@animalabs/context-manager';
import { AgentFramework, AutobiographicalStrategy, OperatorActionError, PassthroughStrategy, residentContextOptions } from '../src/index.js';
import type { FrameworkConfig, Module, OperatorLogEntry, TraceEvent } from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import { SemanticIndexClient, SemanticIndexer, type SyncCursors } from '../src/modules/history/semantic.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

const OLD = 'OLDWORDS';
const NEW = 'NEWWORDS';
const NAME = 'rewords-test';
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const FILLER = 'filler words for the long note ';
const MORE_FILLER = 'more filler for the note ';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const textOf = (blocks: readonly { type: string; text?: string }[]): string => blocks.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');

function rewords(): SweepEntry {
  return {
    name: NAME,
    line: "mends the old words in the faulty test writer's notes",
    mend: (body) => {
      if (body.metadata?.writer !== 'faulty') return null;
      if (!body.content.some((b) => b.type === 'text' && b.text.includes(OLD))) return null;
      if (body.content.some((b) => b.type === 'text' && b.text.includes('BOOM'))) throw new Error('boom');
      return body.content.map((b): StoredContentBlock =>
        b.type === 'text' ? { type: 'text', text: b.text.replaceAll(OLD, NEW).replaceAll(FILLER, '').replaceAll(MORE_FILLER, '') } : b,
      );
    },
  };
}

class SummaryMembrane extends MockMembrane {
  summaries = 0;
  hold: Promise<void> | null = null;
  override async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.summaries++;
    if (this.hold) await this.hold;
    const texts = request.messages.map((m) => textOf(m.content as { type: string; text?: string }[]));
    let marker = -1;
    for (let i = 0; i < texts.length; i++) if (texts[i]!.startsWith('System: You will soon form a new memory')) marker = i;
    const folded = (marker === -1 ? texts : texts.slice(marker + 1, -1)).join('\n');
    const words = [folded.includes(OLD) ? OLD : '', folded.includes(NEW) ? NEW : ''].filter(Boolean).join(' ');
    return createMockResponse([text(`[summary ${this.summaries} ${words}] ` + 'mem '.repeat(20))]);
  }
}

const FOLD = {
  compressionModel: 'mock',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  l1HoldbackChunks: 0,
  hierarchical: false,
} as const;
const folding = (): ContextStrategy => new AutobiographicalStrategy({ ...FOLD });
const adaptive = (): ContextStrategy => new AutobiographicalStrategy({ ...FOLD, adaptiveResolution: true });

const cmOf = (framework: AgentFramework, agent: string): ContextManager => framework.getAgent(agent)!.getContextManager();
const sequenceOf = (framework: AgentFramework, agent = 'mira'): number => cmOf(framework, agent).getStore().currentSequence();

function note(cm: ContextManager, words: string, metadata: Record<string, unknown> = {}): MessageId {
  return cm.addMessage('system', [text(words)], { writer: 'faulty', ...metadata });
}

function longNote(cm: ContextManager, marker: string): MessageId {
  return note(cm, `${marker} ${FILLER.repeat(120)}${OLD} in the middle ${MORE_FILLER.repeat(120)}end of ${marker}`);
}

function bodyRows(cm: ContextManager, id: MessageId): MessageId[] {
  const all = cm.getAllMessages();
  const at = all.findIndex((m) => m.id === id);
  const first = all[at]!;
  if (!first.bodyGroupId) return [id];
  const rows = [id];
  for (let i = at + 1; i < all.length && all[i]!.bodyGroupId === first.bodyGroupId && (all[i]!.shardIndex ?? 0) > (all[i - 1]!.shardIndex ?? 0); i++) rows.push(all[i]!.id);
  return rows;
}

function presentAll(framework: AgentFramework, ...agents: string[]): void {
  for (const agent of agents) {
    const cm = cmOf(framework, agent);
    const held = new Set(cm.getPresentedMessages().map((m) => m.id));
    const ids = cmOf(framework, 'mira').getAllMessages().map((m) => m.id).filter((id) => !held.has(id));
    if (ids.length > 0) cm.presentRows(ids);
  }
}

async function compiledText(cm: ContextManager, dryRun = false): Promise<string> {
  const result = await cm.compile(BIG, undefined, dryRun ? { dryRun: true } : undefined);
  return result.messages.map((m) => textOf(m.content as { type: string; text?: string }[])).join('\n');
}

async function drain(cm: ContextManager): Promise<void> {
  await cm.compile(BIG);
  for (let i = 0; i < 300 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

function busy(framework: AgentFramework, agent: string, on: boolean): void {
  (framework.getAgent(agent) as unknown as { _state: { status: string } })._state = { status: on ? 'inferring' : 'idle' };
}

function readLog(path: string): OperatorLogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as OperatorLogEntry);
}

const total = (levels: readonly { count: number }[]): number => levels.reduce((sum, each) => sum + each.count, 0);

function failFrom(cm: ContextManager, method: 'editStateItem' | 'redactStateItems', from: number, slot = 'messages') {
  const target = cm.getStore() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = target[method]!;
  let calls = 0;
  target[method] = function (this: unknown, ...args: unknown[]) {
    if (args[0] === slot && ++calls >= from) throw new Error(`test: ${method} stopped`);
    return real.apply(this, args);
  };
  return { restore: () => { target[method] = real; } };
}

describe('sweeps through the framework', () => {
  let tempDir: string;
  let storePath: string;
  let membrane: SummaryMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'framework-sweep-'));
    storePath = join(tempDir, 'store.chronicle');
    membrane = new SummaryMembrane();
    frameworks = [];
  });
  afterEach(async () => {
    for (const framework of frameworks.reverse()) { try { await framework.stop(); } catch { /* stopped already */ } }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function boot(options: {
    residents?: string[];
    strategy?: () => ContextStrategy;
    subconscious?: boolean;
    sweeps?: SweepEntry[];
    modules?: Module[];
    conversations?: boolean;
  } = {}): Promise<AgentFramework> {
    const config: FrameworkConfig = {
      storePath,
      membrane: membrane.asMembrane(),
      agents: (options.residents ?? ['mira']).map((name) => ({
        name,
        model: 'test-model',
        systemPrompt: `You are ${name}.`,
        ...(options.strategy ? { strategy: options.strategy() } : {}),
      })),
      modules: options.modules ?? [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      sweeps: options.sweeps ?? [rewords()],
      ...(options.subconscious ? { subconscious: { enabled: true, name: 'deep', systemPrompt: 'You notice.' } } : {}),
      ...(options.conversations ? { conversations: { templateAgent: 'mira' } } : {}),
    };
    const framework = await AgentFramework.create(config);
    frameworks.push(framework);
    return framework;
  }

  async function restart(framework: AgentFramework, options: Parameters<typeof boot>[0] = {}): Promise<AgentFramework> {
    await framework.stop();
    frameworks.splice(frameworks.indexOf(framework), 1);
    return boot(options);
  }

  it('T1: a show lists each body once, with the agents whose window holds it, and writes nothing, also while a take waits', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a note with ${OLD}`);
    note(mira, 'a note of nobody faulty', { writer: 'someone' });
    presentAll(framework, 'mira');
    const before = sequenceOf(framework);
    const shown = framework.showSweep(NAME);
    assert.equal(sequenceOf(framework), before, 'a show writes nothing');
    assert.equal(shown.line, rewords().line);
    assert.deepEqual(shown.changes.map((c) => c.id), [id], 'the body once, though two residents write its slot');
    assert.deepEqual(shown.changes[0]!.agents, ['mira'], 'only mira\'s window holds it');
    assert.equal(shown.changes[0]!.oldLength, `a note with ${OLD}`.length);
    assert.equal(shown.changes[0]!.newLength, `a note with ${NEW}`.length);

    busy(framework, 'oren', true);
    const held = await framework.takeSweep(NAME);
    busy(framework, 'oren', false);
    assert.equal(held.outcome, 'held', 'premise: the take waits');
    assert.ok(held.took && framework.sweepReceipt(NAME).take?.take === held.took.take, 'premise: the store holds the take');
    const taken = sequenceOf(framework);
    framework.showSweep(NAME);
    assert.equal(sequenceOf(framework), taken, 'a show while the take waits writes nothing');
  });

  it('T2: no answer holds the old text: the show, the take and the receipt', async () => {
    const framework = await boot();
    note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const shown = framework.showSweep(NAME);
    assert.equal(shown.changes.length, 1, 'premise: the show lists the note');
    assert.ok(!JSON.stringify(shown).includes(OLD), 'the show');
    const write = await framework.takeSweep(NAME);
    assert.equal(write.outcome, 'finished', 'premise: the take finished');
    assert.ok(!JSON.stringify(write).includes(OLD), 'the take');
    assert.ok(!JSON.stringify(framework.sweepReceipt(NAME)).includes(OLD), 'the receipt');
  });

  it('T3: a take on an idle host mends every resident\'s next request, a sharded body in its place, and the operator log names who, the sweep and the counts', async () => {
    const framework = await boot({ residents: ['mira', 'oren'], strategy: adaptive });
    const mira = cmOf(framework, 'mira');
    mira.addMessage('User', [text('BEFORE')]);
    const one = note(mira, `a note with ${OLD}`);
    const long = longNote(mira, 'LONG');
    mira.addMessage('User', [text('AFTER')]);
    const shards = bodyRows(mira, long);
    assert.ok(shards.length > 1, 'premise: the long note is stored as shards');
    presentAll(framework, 'mira', 'oren');

    const write = await framework.takeSweep(NAME, { requester: { via: 'test', name: 'op' }, note: 'mend' });
    assert.equal(write.outcome, 'finished');
    assert.ok(write.took, 'it took the sweep');
    for (const agent of ['mira', 'oren']) {
      const compiled = await compiledText(cmOf(framework, agent));
      assert.ok(!compiled.includes(OLD), `${agent}'s request holds none of the old text`);
      assert.ok(compiled.includes(`a note with ${NEW}`), `${agent}'s request holds the mended note`);
      const before = compiled.indexOf('BEFORE');
      const at = compiled.indexOf(`LONG ${NEW} in the middle end of LONG`);
      assert.ok(before !== -1 && at > before && compiled.indexOf('AFTER') > at, `${agent}: the joined note keeps its place`);
    }
    assert.ok(mira.getMessage(one), 'the one-row body keeps its id');
    const entry = readLog(framework.getOperatorLogPath()!).find((e) => e.kind === 'sweep');
    assert.ok(entry, 'the take is in the operator log');
    assert.deepEqual(entry.requester, { via: 'test', name: 'op' });
    assert.equal(entry.note, 'mend');
    assert.deepEqual(entry.params, { sweep: NAME });
    assert.equal(entry.result?.outcome, 'finished');
    assert.equal(entry.result?.rewritten, 2);
    assert.equal(entry.result?.removed, shards.length - 1);
  });

  it('T4: a second take takes nothing and rewrites nothing; the show then lists nothing, and the receipt names the pass', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const id = note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira', 'oren');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const before = sequenceOf(framework);
    const second = await framework.takeSweep(NAME);
    assert.equal(second.outcome, 'finished');
    assert.equal(second.took, null, 'no second take');
    assert.equal(sequenceOf(framework), before, 'nothing written');
    assert.deepEqual(framework.showSweep(NAME).changes, []);
    const receipt = framework.sweepReceipt(NAME);
    assert.ok(receipt.take && receipt.finished);
    assert.deepEqual(receipt.passes.flatMap((pass) => pass.bodies.map((body) => body.id)), [id], 'one pass, named once');
  });

  it('T5: a take while a turn is alive rewrites nothing and says so; the same call between turns applies it without a second take, and a write made under its hold is stored at the release', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira', 'oren');
    busy(framework, 'oren', true);
    const held = await framework.takeSweep(NAME);
    busy(framework, 'oren', false);
    assert.equal(held.outcome, 'held');
    assert.ok(held.took, 'the store took it');
    assert.match(held.outcome === 'held' ? held.refusal : '', /oren/, 'it names the agent in a turn');
    assert.ok(textOf(mira.getMessage(id)!.content).includes(OLD), 'nothing rewritten');

    let during: MessageId | undefined;
    framework.onTrace((event: TraceEvent) => {
      if (event.type !== 'sweep:pass' || during !== undefined) return;
      during = (framework as unknown as { addMessage(p: string, c: ContentBlock[], m: Record<string, unknown>): MessageId })
        .addMessage('User', [text('WRITTEN UNDER THE HOLD')], {});
    });
    const applied = await framework.takeSweep(NAME);
    assert.equal(applied.outcome, 'finished');
    assert.equal(applied.took, null, 'the owed take is applied, not taken again');
    assert.ok(textOf(mira.getMessage(id)!.content).includes(NEW));
    assert.equal(during, '', 'premise: the hold kept the write in memory');
    assert.ok(mira.getAllMessages().some((m) => textOf(m.content).includes('WRITTEN UNDER THE HOLD')), 'stored at the release');
  });

  it('T6: a restart applies a take that waited: a load alone rewrites nothing, and the first request after the start holds none of the old text', async () => {
    let framework = await boot();
    const id = note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira');
    busy(framework, 'mira', true);
    assert.equal((await framework.takeSweep(NAME)).outcome, 'held', 'premise: taken, not applied');
    busy(framework, 'mira', false);
    await framework.stop();
    frameworks.splice(frameworks.indexOf(framework), 1);

    const opened = await ContextManager.open({ path: storePath, ...residentContextOptions('mira'), strategy: new PassthroughStrategy() });
    assert.ok(textOf(opened.getMessage(id)!.content).includes(OLD), 'a load rewrites nothing');
    opened.close();

    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework = await boot();
    } finally {
      console.error = error;
    }
    const compiled = await compiledText(cmOf(framework, 'mira'));
    assert.ok(!compiled.includes(OLD) && compiled.includes(`a note with ${NEW}`), 'the start mended it before the first request');
    assert.ok(framework.sweepReceipt(NAME).finished);
    assert.ok(logged.some((line) => line.startsWith('[sweep] start: mira on ') && line.includes(`${NAME} finished, 1 rewritten`)), 'the start\'s pass is logged');
  });

  it('T7: a take whose second rewrite fails, then a restart: the start mends the rest, and the receipt names both bodies', async () => {
    let framework = await boot();
    const mira = cmOf(framework, 'mira');
    const first = note(mira, `first ${OLD}`);
    const second = note(mira, `second ${OLD}`);
    presentAll(framework, 'mira');
    const stop = failFrom(mira, 'editStateItem', 2);
    const write = await framework.takeSweep(NAME);
    stop.restore();
    assert.equal(write.outcome, 'failed', 'the take says a body was not rewritten');
    assert.deepEqual(write.outcome === 'failed' ? write.failed.map((f) => f.id) : [], [second]);
    assert.ok(textOf(mira.getMessage(first)!.content).includes(NEW), 'premise: the first landed');

    framework = await restart(framework);
    assert.ok(!(await compiledText(cmOf(framework, 'mira'))).includes(OLD));
    const receipt = framework.sweepReceipt(NAME);
    assert.ok(receipt.finished);
    assert.deepEqual(new Set(receipt.passes.flatMap((pass) => pass.bodies.map((body) => body.id))), new Set([first, second]));
  });

  it('T8: a stop between a long note\'s rewrite and its shards\' removal, then a restart: both residents load, and the start removes the shards before any request', async () => {
    let framework = await boot({ residents: ['mira', 'oren'], strategy: adaptive });
    const mira = cmOf(framework, 'mira');
    const long = longNote(mira, 'LONG');
    mira.addMessage('User', [text('AFTER')]);
    const shards = bodyRows(mira, long);
    assert.ok(shards.length > 1, 'premise: sharded');
    presentAll(framework, 'mira', 'oren');
    const stop = failFrom(mira, 'redactStateItems', 1);
    await framework.takeSweep(NAME);
    stop.restore();
    assert.ok(mira.getMessage(shards[1]!), 'premise: its later shards stayed');

    framework = await restart(framework, { residents: ['mira', 'oren'], strategy: adaptive });
    for (const agent of ['mira', 'oren']) {
      const cm = cmOf(framework, agent);
      for (const shard of shards.slice(1)) assert.equal(cm.getMessage(shard), null, `${agent}: the shard is gone`);
      const compiled = await compiledText(cm);
      assert.ok(!compiled.includes(OLD) && compiled.includes('end of LONG'), `${agent}: the note is one row, mended`);
    }
  });

  it('T9: a rollback to before a take mends the branch it moves to, with no command, and traces the pass', async () => {
    const framework = await boot();
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const target = mira.addMessage('User', [text('TARGET')]);
    presentAll(framework, 'mira');
    mira.addMessage('User', [text('TAIL')]);
    presentAll(framework, 'mira');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const passes: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'sweep:pass') passes.push(event); });

    await framework.rollbackToMessage('mira', { messageId: target });
    assert.ok(textOf(mira.getMessage(id)!.content).includes(NEW), 'the branch it moved to is mended');
    assert.ok(!(await compiledText(mira)).includes(OLD));
    assert.ok(passes.some((event) => event.type === 'sweep:pass' && event.point === 'move' && event.report.sweeps.some((s) => s.rewritten.includes(id))),
      'the move\'s pass is traced');
  });

  it('T9b: a branch move in a store that never took a sweep asks for the pass, which rewrites nothing and is not traced', async () => {
    const framework = await boot();
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const target = mira.addMessage('User', [text('TARGET')]);
    presentAll(framework, 'mira');
    mira.addMessage('User', [text('TAIL')]);
    presentAll(framework, 'mira');
    const passes: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'sweep:pass') passes.push(event); });
    let asked = 0;
    const apply = mira.applySweeps.bind(mira);
    mira.applySweeps = (entries) => { asked++; return apply(entries); };
    await framework.rollbackToMessage('mira', { messageId: target });
    assert.equal(asked, 1, 'the move asked the context for its pass');
    assert.ok(textOf(mira.getMessage(id)!.content).includes(OLD));
    assert.deepEqual(passes, [], 'a pass with nothing to do is not traced');
  });

  it('T10: after a pass that removed shards, no window keeps them: the applying resident\'s, another resident\'s, and the subconscious\'s', async () => {
    const framework = await boot({ residents: ['mira', 'oren'], strategy: adaptive, subconscious: true });
    const mira = cmOf(framework, 'mira');
    const long = longNote(mira, 'LONG');
    mira.addMessage('User', [text('AFTER')]);
    const later = bodyRows(mira, long).slice(1);
    assert.ok(later.length > 0, 'premise: sharded');
    presentAll(framework, 'mira', 'oren', 'deep');
    for (const agent of ['mira', 'oren', 'deep']) {
      assert.ok(later.every((id) => cmOf(framework, agent).ordinalOf(id) !== undefined), `premise: ${agent}'s window holds each later shard`);
    }
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished');
    for (const agent of ['mira', 'oren', 'deep']) {
      const cm = cmOf(framework, agent);
      assert.deepEqual(later.filter((id) => cm.ordinalOf(id) !== undefined), [], `${agent}'s window keeps no place for a removed shard`);
      assert.ok(!(await compiledText(cm)).includes(OLD), `${agent}'s request holds none of the old text`);
    }
  });

  it('T11: a body that the resident\'s view hides, held traffic, is mended by the take', async () => {
    const framework = await boot();
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a held note with ${OLD}`, { tuneOut: { epochId: 'e1' } });
    presentAll(framework, 'mira');
    assert.ok(!(await compiledText(mira)).includes('a held note'), 'premise: the resident\'s view hides it');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished');
    assert.ok(textOf(mira.getMessage(id)!.content).includes(`a held note with ${NEW}`), 'the stored body is mended');
  });

  async function foldedPair(): Promise<{ framework: AgentFramework; mended: MessageId }> {
    const framework = await boot({ residents: ['mira', 'oren'], strategy: folding });
    const mira = cmOf(framework, 'mira');
    const mended = note(mira, `first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) mira.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    presentAll(framework, 'mira', 'oren');
    for (const agent of ['mira', 'oren']) {
      await drain(cmOf(framework, agent));
      assert.match(await compiledText(cmOf(framework, agent)), new RegExp(`\\[summary \\d+ ${OLD}`), `premise: ${agent} folded the note`);
    }
    return { framework, mended };
  }

  it('T12: after a take, each resident keeps its old summaries, and the show and the receipt count each agent\'s own', async () => {
    const { framework } = await foldedPair();
    const shown = framework.showSweep(NAME);
    const counted = new Map(shown.oldSummaries.map((each) => [each.agent, total(each.summaries)]));
    assert.ok((counted.get('mira') ?? 0) > 0 && (counted.get('oren') ?? 0) > 0, 'the show counts each resident\'s');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished');
    assert.deepEqual(framework.sweepReceipt(NAME).oldSummaries, shown.oldSummaries, 'the receipt counts the same');
    for (const agent of ['mira', 'oren']) {
      const cm = cmOf(framework, agent);
      const live = await compiledText(cm);
      assert.match(live, new RegExp(`\\[summary \\d+ ${OLD}`), `${agent} keeps its old summary`);
      assert.equal(await compiledText(cm, true), live, `${agent}: a dry compile shows the same`);
    }
  });

  it('T13: the second act is refused while any agent\'s turn is alive; then it drops the named resident\'s old summaries only, and the operator log names it', async () => {
    const { framework } = await foldedPair();
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const before = sequenceOf(framework);
    const cost = framework.oldSummaryCost('mira', NAME);
    assert.equal(sequenceOf(framework), before, 'the cost report writes nothing');
    assert.ok(total(cost.summaries) > 0 && cost.records > 0 && cost.rawTokens > 0, 'premise: there is something to drop');

    busy(framework, 'oren', true);
    await assert.rejects(framework.dropOldSummaries('mira', NAME), (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy');
    busy(framework, 'oren', false);
    assert.deepEqual(framework.oldSummaryCost('mira', NAME), cost, 'the refusal dropped nothing');

    const dropped = await framework.dropOldSummaries('mira', NAME, { requester: { via: 'test', name: 'op' }, note: 'drop' });
    assert.deepEqual(dropped, cost, 'it drops what the cost report named');
    assert.ok(!(await compiledText(cmOf(framework, 'mira'), true)).includes(OLD), 'mira\'s next compile holds none of the dropped summaries');
    assert.match(await compiledText(cmOf(framework, 'oren')), new RegExp(`\\[summary \\d+ ${OLD}`), 'oren keeps its own');
    const entry = readLog(framework.getOperatorLogPath()!).find((e) => e.kind === 'sweep-summaries' && !e.error);
    assert.ok(entry, 'the act is in the operator log');
    assert.equal(entry.agent, 'mira');
    assert.deepEqual(entry.requester, { via: 'test', name: 'op' });
    assert.deepEqual(entry.params, { sweep: NAME });
    assert.deepEqual(entry.result, { summaries: cost.summaries, records: cost.records, rawTokens: cost.rawTokens });
    assert.equal(total((await framework.dropOldSummaries('mira', NAME)).summaries), 0, 'a second act drops nothing');
  });

  it('T14: an entry that throws on one body: the take names it and fails, the others are mended, and the sweep stays owed', async () => {
    const framework = await boot();
    const mira = cmOf(framework, 'mira');
    const boom = note(mira, `BOOM ${OLD}`);
    const fine = note(mira, `fine ${OLD}`);
    presentAll(framework, 'mira');
    const write = await framework.takeSweep(NAME);
    assert.equal(write.outcome, 'failed');
    assert.deepEqual(write.outcome === 'failed' ? write.failed.map((f) => f.id) : [], [boom]);
    assert.ok(textOf(mira.getMessage(fine)!.content).includes(NEW));
    assert.equal(framework.sweepReceipt(NAME).finished, false, 'owed');
  });

  it('T15: after a take, the history module\'s semantic index holds the new text for a mended body and nothing for a removed shard, though the indexer was not attached during the pass', async () => {
    const svc = new FakeEmbedService();
    await svc.start();
    try {
      const history = (): HistoryModule => new HistoryModule({ semantic: { url: svc.url, namespace: 'ns', syncIntervalMs: 0, overlapMs: 0 } });
      let module = history();
      let framework = await boot({ strategy: adaptive, modules: [module] });
      const mira = cmOf(framework, 'mira');
      const one = note(mira, `a note with ${OLD}`);
      const long = longNote(mira, 'LONG');
      const later = bodyRows(mira, long).slice(1);
      assert.ok(later.length > 0, 'premise: sharded');
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('LATER')]);
      presentAll(framework, 'mira');
      module.bind(mira);
      await module.syncSemanticIndex();
      assert.ok(svc.items.has(`msg:${later[0]}`), 'premise: the index holds a later shard');
      busy(framework, 'mira', true);
      assert.equal((await framework.takeSweep(NAME)).outcome, 'held', 'premise: taken, not applied');
      busy(framework, 'mira', false);

      module = history();
      framework = await restart(framework, { strategy: adaptive, modules: [module] });
      assert.ok(textOf(cmOf(framework, 'mira').getMessage(one)!.content).includes(NEW), 'premise: the start mended it, with no indexer bound');
      module.bind(cmOf(framework, 'mira'));
      await module.syncSemanticIndex();
      assert.ok(svc.items.get(`msg:${one}`)?.text.includes(NEW), 'the mended body is sent again');
      assert.ok(svc.items.get(`msg:${long}`)?.text.includes(NEW), 'the joined note is sent again');
      for (const shard of later) assert.ok(!svc.items.has(`msg:${shard}`), 'a removed shard leaves the index');
      assert.ok(![...svc.items.values()].some((item) => item.text.includes(OLD)), 'no item holds the old text');
      const sends = svc.sent.filter((id) => id === `msg:${one}`).length;
      await module.syncSemanticIndex();
      assert.equal(svc.sent.filter((id) => id === `msg:${one}`).length, sends, 'a later catch-up reads the list from where it stopped');
    } finally {
      await svc.stop();
    }
  });

  const requestWith = (marker: string): string => {
    const request = [...membrane.calls].reverse().find((call) => JSON.stringify(call.messages).includes(marker));
    assert.ok(request, `a request carried ${marker}`);
    return JSON.stringify(request.messages);
  };

  it('T16: a subagent derived before a take is mended on its own branch before the first turn of its run', async () => {
    const framework = await boot();
    framework.start();
    const mira = cmOf(framework, 'mira');
    const id = note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const fork = await framework.deriveAgent({ name: 'fork-1', from: 'mira', framing: [{ participant: 'user', content: [text('FIRST-RUN')] }] });
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise: the take finished on the store\'s branch');
    assert.ok(textOf(fork.contextManager.getMessage(id)!.content).includes(OLD), 'premise: the child\'s branch holds the old text');
    membrane.pushResponse(createMockResponse([text('fork done')]));
    await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    assert.ok(!requestWith('FIRST-RUN').includes(OLD), 'its first request holds none of the old text');
    assert.ok(requestWith('FIRST-RUN').includes(`a note with ${NEW}`));
  });

  it('T16b: a derived subagent that ended before a take is mended before the first turn of its resumed run', async () => {
    const framework = await boot();
    framework.start();
    const mira = cmOf(framework, 'mira');
    note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const fork = await framework.deriveAgent({ name: 'fork-1', from: 'mira', framing: [{ participant: 'user', content: [text('FIRST-RUN')] }] });
    membrane.pushResponse(createMockResponse([text('fork done')]));
    await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    assert.ok(requestWith('FIRST-RUN').includes(OLD), 'premise: its first run read the old text');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');

    const resumed = await framework.resumeAgent('fork-1', { model: 'test-model', systemPrompt: 'You are mira.' });
    resumed.contextManager.addMessage('user', [text('RESUMED-RUN')]);
    membrane.pushResponse(createMockResponse([text('fork done again')]));
    await framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
    assert.ok(!requestWith('RESUMED-RUN').includes(OLD), 'its resumed run\'s first request holds none of the old text');
  });

  it('T16c: a subagent whose context is new for its run gets no pass: the applied list gains nothing', async () => {
    const framework = await boot();
    framework.start();
    note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const before = sweepsApplied(cmOf(framework, 'mira').getStore()).length;
    const fork = await framework.deriveAgent({ name: 'copy-1', from: 'mira', mode: 'copy', framing: [{ participant: 'user', content: [text('COPY-RUN')] }] });
    membrane.pushResponse(createMockResponse([text('copy done')]));
    await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    assert.ok(requestWith('COPY-RUN'), 'premise: the copy ran');
    assert.equal(sweepsApplied(cmOf(framework, 'mira').getStore()).length, before);
  });

  it('T16d: a conversation fork opened on a namespace that already held rows is mended before it is taken on', async () => {
    const framework = await boot({ conversations: true });
    note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira');
    const earlier = await ContextManager.open({ store: cmOf(framework, 'mira').getStore(), namespace: 'conversations/conv-g1', isolate: true, strategy: new PassthroughStrategy() });
    const id = note(earlier, `an earlier engagement's note with ${OLD}`);
    earlier.close();
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise: the residents\' slot is mended');
    const internals = framework as unknown as { createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }> };
    const fork = await internals.createConversationAgent('conv-g1', { serverId: 'stub', channelId: 'world:probe' });
    assert.ok(textOf(cmOf(framework, fork.name).getMessage(id)!.content).includes(NEW));
  });

  it('T18: a take and a second act each wait for a maintenance pass that is running', async () => {
    const framework = await boot({ strategy: folding });
    framework.start();
    const mira = cmOf(framework, 'mira');
    note(mira, `first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) mira.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    presentAll(framework, 'mira');
    const internals = framework as unknown as { startQueuedMaintenance(): void; maintenancePass: Promise<void> | null };
    const order: string[] = [];
    framework.onTrace((event) => { if (event.type === 'sweep:pass') order.push('pass'); });
    const maintainHeld = async (): Promise<() => void> => {
      let release!: () => void;
      membrane.hold = new Promise<void>((resolve) => { release = resolve; });
      const calls = membrane.summaries;
      internals.startQueuedMaintenance();
      const pass = internals.maintenancePass;
      assert.ok(pass, 'premise: a maintenance pass runs');
      void pass.then(() => order.push('maintained'));
      await until(() => membrane.summaries > calls, 'a summary call to start');
      return release;
    };

    let release = await maintainHeld();
    try {
      const take = framework.takeSweep(NAME);
      release();
      assert.equal((await take).outcome, 'finished');
    } finally {
      release();
    }
    assert.deepEqual(order.slice(0, 2), ['maintained', 'pass'], 'the take\'s pass came after the maintenance pass ended');

    membrane.hold = null;
    await drain(mira);
    assert.ok(total(framework.oldSummaryCost('mira', NAME).summaries) > 0, 'premise: an old summary to drop');
    for (let i = 0; i < 4; i++) mira.addMessage('User', [text(`more ${i} ${'words '.repeat(60)}`)]);
    presentAll(framework, 'mira');
    order.length = 0;
    release = await maintainHeld();
    try {
      const drop = framework.dropOldSummaries('mira', NAME).then((cost) => { order.push('dropped'); return cost; });
      release();
      assert.ok(total((await drop).summaries) > 0);
    } finally {
      release();
    }
    assert.deepEqual(order, ['maintained', 'dropped'], 'the second act came after the maintenance pass ended');
  });

  it('T19: the show is of the store\'s branch: a live subagent\'s own branch adds nothing to it', async () => {
    const routed = new RoutedMembrane();
    const gates = new GateModule();
    const framework = await AgentFramework.create({
      storePath,
      membrane: routed.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
      modules: [gates],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      sweeps: [rewords()],
    });
    frameworks.push(framework);
    framework.start();
    routed.identify = (request) => (JSON.stringify(request.messages).includes('FORK-RUN') ? 'fork-1' : request.assistantParticipant ?? '');
    routed.script('fork-1', waitCall('g-fork'), say('fork done'));
    const fork = await framework.deriveAgent({ name: 'fork-1', from: 'mira', framing: [{ participant: 'user', content: [text('FORK-RUN')] }] });
    const run = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    await until(() => gates.entered.has('g-fork'), 'the fork to block mid-turn');
    note(fork.contextManager, `a note on the fork's branch with ${OLD}`);
    assert.equal(fork.contextManager.showSweep(rewords()).changes.length, 1, 'premise: its own branch has a body to change');
    assert.deepEqual(framework.showSweep(NAME).changes, [], 'the show lists nothing of another branch');
    gates.release('g-fork');
    await run;
  });

  it('T20: a pass that throws is traced and named in the answer, and the other contexts make theirs', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const id = note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira', 'oren');
    const failed: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'sweep:pass-failed') failed.push(event); });
    const mira = cmOf(framework, 'mira');
    mira.applySweeps = () => { throw new Error('test: this context can make no pass'); };
    const write = await framework.takeSweep(NAME);
    assert.equal(write.outcome, 'finished', 'oren\'s pass mended the slot that both write');
    assert.deepEqual(write.outcome === 'finished' ? write.threw.map((each) => each.agent) : [], ['mira'], 'the answer names the context whose pass threw');
    assert.ok(textOf(cmOf(framework, 'oren').getMessage(id)!.content).includes(NEW));
    assert.deepEqual(failed.map((event) => event.type === 'sweep:pass-failed' ? [event.point, event.agentName] : []), [['take', 'mira']]);
    assert.match(failed[0]!.type === 'sweep:pass-failed' ? failed[0]!.error : '', /test: this context can make no pass/);
  });

  it('T21: a live agent whose context is closed is passed by: the show and the take read the others, and a take with no open context is refused', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const id = note(cmOf(framework, 'mira'), `a note with ${OLD}`);
    presentAll(framework, 'mira', 'oren');
    const failed: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'sweep:pass-failed') failed.push(event); });
    cmOf(framework, 'oren').close();
    assert.deepEqual(framework.showSweep(NAME).changes.map((change) => change.id), [id]);
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished');
    assert.deepEqual(failed, [], 'no pass is tried through the closed context');
    cmOf(framework, 'mira').close();
    await assert.rejects(framework.takeSweep(NAME), (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid');
  });

  it('T4b: after a finished take, a new body whose entry throws is taken again, and the take names it', async () => {
    const framework = await boot();
    const mira = cmOf(framework, 'mira');
    note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const boom = note(mira, `BOOM ${OLD}`);
    presentAll(framework, 'mira');
    const write = await framework.takeSweep(NAME);
    assert.equal(write.outcome, 'failed');
    assert.ok(write.took, 'a new take');
    assert.deepEqual(write.outcome === 'failed' ? write.failed.map((f) => f.id) : [], [boom]);
  });

  it('T22: a move whose re-initialization of a context fails makes no pass through that context', async () => {
    const framework = await boot({ residents: ['mira', 'oren'] });
    const mira = cmOf(framework, 'mira');
    note(mira, `a note with ${OLD}`);
    presentAll(framework, 'mira', 'oren');
    const target = mira.addMessage('User', [text('TARGET')]);
    presentAll(framework, 'mira', 'oren');
    mira.addMessage('User', [text('TAIL')]);
    presentAll(framework, 'mira', 'oren');
    assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
    const oren = cmOf(framework, 'oren');
    oren.setStrategy = async () => { throw new Error('test: this context can not follow the move'); };
    let asked = 0;
    const apply = oren.applySweeps.bind(oren);
    oren.applySweeps = (entries) => { asked++; return apply(entries); };
    await framework.rollbackToMessage('mira', { messageId: target });
    assert.equal(asked, 0);
  });

  async function indexed(svc: FakeEmbedService, framework: AgentFramework, cursors: { value: SyncCursors | null }): Promise<SemanticIndexer> {
    const cfg = { url: svc.url, namespace: 'ns', syncIntervalMs: 0, overlapMs: 0 };
    const indexer = new SemanticIndexer(cmOf(framework, 'mira'), new SemanticIndexClient(cfg), cfg);
    indexer.cursorStore = { read: () => cursors.value, write: (c) => { cursors.value = c; } };
    return indexer;
  }

  it('T15b: a cursor written before sweeps had one reads the applied list from its start', async () => {
    const svc = new FakeEmbedService();
    await svc.start();
    try {
      const framework = await boot();
      const mira = cmOf(framework, 'mira');
      const one = note(mira, `a note with ${OLD}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('LATER')]);
      presentAll(framework, 'mira');
      const cursors: { value: SyncCursors | null } = { value: null };
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
      const old: SyncCursors = { ...cursors.value! };
      delete old.sweeps;
      cursors.value = old;
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.ok(svc.items.get(`msg:${one}`)?.text.includes(NEW));
    } finally {
      await svc.stop();
    }
  });

  it('T15c: an index restored to a backup older than the message cursor gets the sweep\'s rewrites again', async () => {
    const svc = new FakeEmbedService();
    await svc.start();
    try {
      const framework = await boot();
      const mira = cmOf(framework, 'mira');
      const one = note(mira, `a note with ${OLD}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('LATER')]);
      presentAll(framework, 'mira');
      const cursors: { value: SyncCursors | null } = { value: null };
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      const backup = new Map(svc.items);
      assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('NEWER')]);
      presentAll(framework, 'mira');
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.ok(svc.items.get(`msg:${one}`)?.text.includes(NEW), 'premise: the rewrite reached the index');
      svc.items = backup;
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.ok(svc.items.get(`msg:${one}`)?.text.includes(NEW));
    } finally {
      await svc.stop();
    }
  });

  it('T15d: a catch-up sends no more of a sweep\'s rewrites than its budget, and the next sends the rest', async () => {
    const svc = new FakeEmbedService();
    await svc.start();
    try {
      const framework = await boot();
      const mira = cmOf(framework, 'mira');
      const notes = [1, 2, 3].map((i) => note(mira, `note ${i} with ${OLD}`));
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('LATER')]);
      presentAll(framework, 'mira');
      const cursors: { value: SyncCursors | null } = { value: null };
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.equal((await framework.takeSweep(NAME)).outcome, 'finished', 'premise');
      const before = svc.sent.length;
      const first = await (await indexed(svc, framework, cursors)).catchUp(2);
      const sentNotes = svc.sent.slice(before).filter((id) => notes.some((note) => id === `msg:${note}`));
      assert.equal(sentNotes.length, 2, 'two of the three rewrites');
      assert.equal(first.more, true);
      await (await indexed(svc, framework, cursors)).catchUp(2);
      for (const id of notes) assert.ok(svc.items.get(`msg:${id}`)?.text.includes(NEW));
    } finally {
      await svc.stop();
    }
  });

  it('T15e: a later shard that a stopped pass left in the store stays in the index until a pass removes it', async () => {
    const svc = new FakeEmbedService();
    await svc.start();
    try {
      let framework = await boot({ strategy: adaptive });
      let mira = cmOf(framework, 'mira');
      const long = longNote(mira, 'LONG');
      const later = bodyRows(mira, long).slice(1);
      assert.ok(later.length > 0, 'premise: sharded');
      await new Promise((resolve) => setTimeout(resolve, 5));
      mira.addMessage('User', [text('LATER')]);
      presentAll(framework, 'mira');
      const cursors: { value: SyncCursors | null } = { value: null };
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.ok(svc.items.has(`msg:${later[0]}`), 'premise: indexed');
      const stop = failFrom(mira, 'redactStateItems', 1);
      await framework.takeSweep(NAME);
      stop.restore();
      assert.ok(mira.getMessage(later[0]!), 'premise: the shard stayed in the store');
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      assert.ok(svc.items.has(`msg:${later[0]}`), 'the index keeps a shard that the store still holds');
      framework = await restart(framework, { strategy: adaptive });
      mira = cmOf(framework, 'mira');
      assert.equal(mira.getMessage(later[0]!), null, 'premise: the start removed it');
      await (await indexed(svc, framework, cursors)).catchUp(1024);
      for (const shard of later) assert.ok(!svc.items.has(`msg:${shard}`), 'then the index lets it go');
    } finally {
      await svc.stop();
    }
  });

  it('T17: two entries with one name refuse the framework; a show or a take of an unknown sweep, and the cost of an unknown agent, are refused', async () => {
    await assert.rejects(boot({ sweeps: [rewords(), rewords()] }), /Two sweep entries are named "rewords-test"/);
    assert.ok(!existsSync(storePath), 'the refusal opened no store');
    const framework = await boot();
    assert.throws(() => framework.showSweep('nothing'), (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid');
    await assert.rejects(framework.takeSweep('nothing'), (e: unknown) => e instanceof OperatorActionError && e.code === 'invalid');
    assert.throws(() => framework.oldSummaryCost('nobody', NAME), (e: unknown) => e instanceof OperatorActionError && e.code === 'unknown-agent');
    assert.deepEqual(framework.listSweeps(), [{ name: NAME, line: rewords().line }]);
  });
});

interface Item { id: string; text: string; kind: string; cursor?: number }

class FakeEmbedService {
  items = new Map<string, Item>();
  sent: string[] = [];
  private server!: Server;
  url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search|delete)$/.exec(req.url ?? '');
        const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (!m) return json(404, {});
        if (m[2] === 'stats') {
          if (this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
          const by: Record<string, { count: number; max_ts: null; min_ts: null; max_cursor: number | null }> = {};
          for (const it of this.items.values()) {
            const d = by[it.kind] ??= { count: 0, max_ts: null, min_ts: null, max_cursor: null };
            d.count++;
            if (it.cursor !== undefined) d.max_cursor = d.max_cursor === null ? it.cursor : Math.max(d.max_cursor, it.cursor);
          }
          return json(200, { namespace: 'ns', model: 'fake', dim: 4, count: this.items.size, by_kind: by });
        }
        if (m[2] === 'delete') {
          const ids = (JSON.parse(body) as { ids: string[] }).ids;
          let deleted = 0;
          for (const id of ids) if (this.items.delete(id)) deleted++;
          return json(200, { namespace: 'ns', deleted, count: this.items.size });
        }
        if (m[2] === 'upsert') {
          let inserted = 0, updated = 0, unchanged = 0;
          for (const it of (JSON.parse(body) as { items: Item[] }).items) {
            this.sent.push(it.id);
            const had = this.items.get(it.id);
            if (!had) inserted++; else if (had.text === it.text) unchanged++; else updated++;
            this.items.set(it.id, it);
          }
          return json(200, { namespace: 'ns', inserted, updated, unchanged, count: this.items.size });
        }
        return json(200, { namespace: 'ns', hits: [], count_indexed: this.items.size, timing_ms: { embed: 1, search: 1 } });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }
  stop(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
}
