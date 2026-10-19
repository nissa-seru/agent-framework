// Beth-2389: what framework/state holds after FORKS forks (a 50-message resident), and how its size grows.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Run from a built checkout of agent-framework #546 whose chronicle and context-manager are #40's and #238's.
const AF = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { AgentFramework } = await import(`${AF}/dist/src/index.js`);
const { createMockResponse, MockYieldingStream } = await import(`${AF}/dist/test/helpers/mock-membrane.js`);
const FORKS = Number(process.argv[2] ?? 30);
const membrane = { streamYielding: () => new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ok' }])]), complete: async () => createMockResponse([{ type: 'text', text: 'ok' }]) };
const dir = mkdtempSync(join(tmpdir(), 'beth-usage-'));
const framework = await AgentFramework.create({ storePath: join(dir, 's.chronicle'), membrane, syncIntervalMs: 0, maintenanceIntervalMs: 0, modules: [], agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }] });
const cm = framework.getAgent('mira').getContextManager();
for (let i = 0; i < 50; i++) cm.addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}.` }]);
await framework.start();
const show = (n) => {
  const s = framework.getStore().getStateJson('framework/state') ?? {};
  const usage = s.usage ?? {};
  const top = Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? `object with ${Object.keys(v).length} keys` : Array.isArray(v) ? `array of ${v.length}` : typeof v]));
  console.log('USAGE ' + JSON.stringify({ forks: n, stateBytes: JSON.stringify(s).length, topKeys: Object.keys(s), usageShape: top, sampleAgentKeys: Object.keys(usage.byAgent ?? usage.agents ?? {}).slice(0, 4) }));
};
show(0);
for (let i = 1; i <= FORKS; i++) {
  const fork = await framework.deriveAgent({ name: `fork-${i}`, from: 'mira', idleTimeoutMs: 600_000, pendingRound: { include: false }, framing: [{ participant: 'user', content: [{ type: 'text', text: `[FORK ${i}]` }] }] });
  await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
}
show(FORKS);
await framework.stop();
rmSync(dir, { recursive: true, force: true });
