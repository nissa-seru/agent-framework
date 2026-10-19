// Growth probe (Beth-2389), agent-framework #546 on the composed rig (chronicle #40, context-manager #238):
// what a resident that forks often accumulates. A resident `mira` with SEED stored messages (passthrough
// strategy, mock model) derives N task forks one after another with shared inheritance, each running one
// mock turn and ending. At checkpoints it prints the store's size on disk, its branch count and how long
// listBranches takes, the registry's snapshot and ended log, the process's memory after a GC, a derive's
// and a run's median time over the last batch, and mira's own compile time. Then it reopens the store
// (AgentFramework.create) and times that against the same store's reopen before any fork.
// Run: node --expose-gc probe-fork-growth.mjs [N] [SEED]
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Run from a built checkout of agent-framework #546 whose chronicle and context-manager are #40's and #238's.
const AF = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { AgentFramework } = await import(`${AF}/dist/src/index.js`);
const { createMockResponse, MockYieldingStream } = await import(`${AF}/dist/test/helpers/mock-membrane.js`);

const N = Number(process.argv[2] ?? 2000);
const SEED = Number(process.argv[3] ?? 2000);
const CHECKS = new Set([0, 100, 250, 500, 1000, 1500, 2000, 3000, 4000, 5000].filter((n) => n <= N).concat([N]));

class CountingMembrane {
  n = 0;
  streamYielding() { this.n++; return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ok' }])]); }
  async complete() { return createMockResponse([{ type: 'text', text: 'ok' }]); }
}
const membrane = new CountingMembrane();
const dir = mkdtempSync(join(tmpdir(), 'beth-fork-growth-'));
const storePath = join(dir, 'store.chronicle');
const options = () => ({
  storePath, membrane, syncIntervalMs: 0, maintenanceIntervalMs: 0, modules: [],
  agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
});
const du = (p) => {
  let total = 0;
  const walk = (q) => { for (const e of readdirSync(q, { withFileTypes: true })) { const f = join(q, e.name); if (e.isDirectory()) walk(f); else total += statSync(f).size; } };
  walk(p);
  return total;
};
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (t) => Math.round(t * 100) / 100;

let framework = await AgentFramework.create(options());
const mira = framework.getAgent('mira');
for (let i = 0; i < SEED; i++) {
  mira.getContextManager().addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(50) }]);
}
framework.getStore().sync();
await framework.stop();
let t0 = performance.now();
framework = await AgentFramework.create(options());
const reopenBefore = performance.now() - t0;
await framework.start();
console.log('GROWTH ' + JSON.stringify({ phase: 'setup', seed: SEED, n: N, reopenMsBeforeForks: ms(reopenBefore), storeBytes: du(dir) }));

const store = () => framework.getStore();
const checkpoint = (i, derives, runs) => {
  store().sync();
  global.gc?.();
  const m = process.memoryUsage();
  let t = performance.now();
  const branches = store().listBranches().length;
  const listMs = performance.now() - t;
  const snap = store().getState('framework/dendrite');
  const endedLen = store().getStateLen('framework/dendrite/ended');
  const endedBuf = store().getState('framework/dendrite/ended');
  const cm = framework.getAgent('mira').getContextManager();
  const compiles = [];
  return (async () => {
    for (let k = 0; k < 3; k++) { t = performance.now(); await cm.compile(); compiles.push(performance.now() - t); }
    console.log('GROWTH ' + JSON.stringify({
      forks: i, branches, listBranchesMs: ms(listMs), storeBytes: du(dir),
      registrySnapshotBytes: snap?.length ?? null, endedLogItems: endedLen, endedLogBytes: endedBuf?.length ?? null,
      rssMB: Math.round(m.rss / 1e5) / 10, heapUsedMB: Math.round(m.heapUsed / 1e5) / 10,
      deriveMsMedian: derives.length ? ms(median(derives)) : null, runMsMedian: runs.length ? ms(median(runs)) : null,
      miraMessages: cm.getAllMessages().length, miraCompileMsMedian: ms(median(compiles)),
      agentsListed: framework.listAgents({ includeEnded: true }).length,
    }));
  })();
};

let derives = [], runs = [];
await checkpoint(0, derives, runs);
for (let i = 1; i <= N; i++) {
  t0 = performance.now();
  const fork = await framework.deriveAgent({
    name: `fork-${i}`, from: 'mira', idleTimeoutMs: 600_000, pendingRound: { include: false },
    framing: [{ participant: 'user', content: [{ type: 'text', text: `[FORK ${i}] count the open issues` }] }],
  });
  const t1 = performance.now();
  await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
  const t2 = performance.now();
  derives.push(t1 - t0); runs.push(t2 - t1);
  if (CHECKS.has(i)) { await checkpoint(i, derives, runs); derives = []; runs = []; }
}
store().sync();
await framework.stop();
t0 = performance.now();
framework = await AgentFramework.create(options());
const reopenAfter = performance.now() - t0;
console.log('GROWTH ' + JSON.stringify({ phase: 'reopen', forks: N, reopenMsAfterForks: ms(reopenAfter), branches: framework.getStore().listBranches().length, agentsListed: framework.listAgents({ includeEnded: true }).length, storeBytes: du(dir), modelCalls: membrane.n }));
await framework.stop();
rmSync(dir, { recursive: true, force: true });
