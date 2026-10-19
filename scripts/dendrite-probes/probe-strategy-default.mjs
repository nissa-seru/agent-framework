// Probe (Beth-2389), agent-framework #546 on the composed rig: a shared fork of a folding resident, derived
// with and without `strategy`. mira folds (AutobiographicalStrategy, as dendrite-derive.test.ts sets it up) over
// SEED long turns; after one turn of hers, each fork is derived at her head and makes one request. The probe
// prints, for mira's last request and each fork's first, the number of provider messages, the request's JSON
// size, and whether it carries folded memory ('[mock summary]').
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Run from a built checkout of agent-framework #546 whose chronicle and context-manager are #40's and #238's.
const AF = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { AgentFramework, AutobiographicalStrategy } = await import(`${AF}/dist/src/index.js`);
const { createMockResponse, MockYieldingStream } = await import(`${AF}/dist/test/helpers/mock-membrane.js`);
const SEED = Number(process.argv[2] ?? 60);
const folding = () => new AutobiographicalStrategy({ compressionModel: 'mock', adaptiveResolution: true, targetChunkTokens: 100, recentWindowTokens: 200 });
const calls = [];
const membrane = {
  streamYielding(request) { calls.push(request); return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ok' }])]); },
  async complete() { return createMockResponse([{ type: 'text', text: '[mock summary]' }]); },
};
const dir = mkdtempSync(join(tmpdir(), 'beth-strategy-default-'));
const framework = await AgentFramework.create({
  storePath: join(dir, 's.chronicle'), membrane, modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', strategy: folding(), contextBudgetTokens: 3200, maxTokens: 200 }],
});
const cm = framework.getAgent('mira').getContextManager();
for (let i = 0; i < SEED; i++) cm.addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]);
while (!cm.isReady()) await cm.tick();
cm.addMessage('user', [{ type: 'text', text: 'Please look into the open issues.' }]);
framework.start();
framework.pendingRequests.push({ agentName: 'mira', reason: 'probe', source: 'probe', timestamp: Date.now() });
await framework.runUntilIdle();
const describe = (who, r) => {
  const json = JSON.stringify(r.messages);
  console.log('STRAT ' + JSON.stringify({ who, messages: r.messages.length, requestChars: json.length, foldedMemory: json.includes('[mock summary]') }));
};
describe('mira, last request', calls.at(-1));
for (const [name, withStrategy] of [['fork-with-strategy', true], ['fork-without-strategy', false]]) {
  const before = calls.length;
  const fork = await framework.deriveAgent({
    name, from: 'mira', idleTimeoutMs: 600_000, pendingRound: { include: false },
    ...(withStrategy ? { strategy: folding() } : {}),
    framing: [{ participant: 'user', content: [{ type: 'text', text: `[FORK] ${name}` }] }],
  });
  await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
  describe(name, calls[before]);
  console.log('STRAT ' + JSON.stringify({ who: name, forkStrategy: fork.contextManager.getStrategy?.()?.name ?? fork.contextManager.strategy?.name ?? null }));
}
await framework.stop();
rmSync(dir, { recursive: true, force: true });
