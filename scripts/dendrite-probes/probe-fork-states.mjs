// Bytes probe (Beth-2389), agent-framework #546 on the composed rig: where a fork's bytes go. A resident with
// SEED messages derives FORKS forks; the probe prints the store's files and sizes before and after, the
// record count, and for one fork's branch each state's item count and opsSinceSnapshot beside the
// resident's, plus the sizes of the states the fork wrote on its branch (view.getState).
// Run: node --expose-gc probe-fork-bytes.mjs [SEED] [FORKS]
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
// Run from a built checkout of agent-framework #546 whose chronicle and context-manager are #40's and #238's.
const AF = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { AgentFramework } = await import(`${AF}/dist/src/index.js`);
const { createMockResponse, MockYieldingStream } = await import(`${AF}/dist/test/helpers/mock-membrane.js`);
const SEED = Number(process.argv[2] ?? 200);
const FORKS = Number(process.argv[3] ?? 10);
const membrane = {
  streamYielding: () => new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ok' }])]),
  complete: async () => createMockResponse([{ type: 'text', text: 'ok' }]),
};
const dir = mkdtempSync(join(tmpdir(), 'beth-fork-bytes-'));
const files = () => {
  const out = {};
  const walk = (q) => { for (const e of readdirSync(q, { withFileTypes: true })) { const f = join(q, e.name); if (e.isDirectory()) walk(f); else out[relative(dir, f)] = statSync(f).size; } };
  walk(dir);
  return out;
};
const framework = await AgentFramework.create({
  storePath: join(dir, 'store.chronicle'), membrane, syncIntervalMs: 0, maintenanceIntervalMs: 0, modules: [],
  agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
});
const cm = framework.getAgent('mira').getContextManager();
for (let i = 0; i < SEED; i++) cm.addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(50) }]);
await framework.start();
const store = framework.getStore();
store.sync();
const kinds = () => {
  const f = files(); const out = { records: 0, blobs: 0, blobCount: 0, stateBin: 0, branchesBin: 0, indexes: 0, other: 0 };
  for (const [k, v] of Object.entries(f)) {
    if (k.endsWith('records.log')) out.records += v;
    else if (k.includes('/blobs/')) { out.blobs += v; out.blobCount++; }
    else if (k.endsWith('state.bin')) out.stateBin += v;
    else if (k.endsWith('branches.bin')) out.branchesBin += v;
    else if (k.endsWith('state-indexes.bin')) out.indexes += v;
    else out.other += v;
  }
  return out;
};
const stateSizes = () => Object.fromEntries(store.listStates().map((s) => { let b = null; try { b = store.getState(s.id)?.length ?? null; } catch (e) { b = 'err'; } return [s.id, { bytes: b, items: s.itemCount ?? null, ops: s.opsSinceSnapshot, strategy: s.strategy }]; }));
const CHECK = new Set((process.env.CHECKS ?? '').split(',').filter(Boolean).map(Number));
console.log('KINDS ' + JSON.stringify({ forks: 0, ...kinds(), miraMessages: cm.getAllMessages().length }));
const before = files();
const statsBefore = store.stats();
for (let i = 1; i <= FORKS; i++) {
  const fork = await framework.deriveAgent({
    name: `fork-${i}`, from: 'mira', idleTimeoutMs: 600_000, pendingRound: { include: false },
    framing: [{ participant: 'user', content: [{ type: 'text', text: `[FORK ${i}] count the open issues` }] }],
  });
  if (process.env.RUN !== '0') await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
  if (CHECK.has(i)) { store.sync(); console.log('KINDS ' + JSON.stringify({ forks: i, ...kinds(), miraMessages: cm.getAllMessages().length, recordCount: store.stats().recordCount })); console.log('SIZES ' + JSON.stringify({ forks: i, ...stateSizes() })); }
}
store.sync();
const after = files();
const statsAfter = store.stats();
console.log('BYTES ' + JSON.stringify({ seed: SEED, forks: FORKS, statsBefore, statsAfter }));
for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
  console.log('FILE ' + JSON.stringify({ file: f, before: before[f] ?? 0, after: after[f] ?? 0, perFork: Math.round(((after[f] ?? 0) - (before[f] ?? 0)) / FORKS) }));
}
const main = Object.fromEntries(store.listStates().map((s) => [s.id, s]));
const view = store.view('dendrite/fork-1');
for (const s of view.listStates()) {
  const buf = view.getState(s.id);
  const m = main[s.id];
  console.log('STATE ' + JSON.stringify({ id: s.id, forkItems: s.itemCount ?? null, forkOps: s.opsSinceSnapshot, mainItems: m?.itemCount ?? null, forkBytes: buf?.length ?? null }));
}
await framework.stop();
rmSync(dir, { recursive: true, force: true });
