/** PROBE (Ramona-2416, reading #546 at 220f4cffe): what a resident is told when an
 * ambient-only batch follows a turn that had a locus, under each speech.locus rule.
 * Not part of the change.
 *
 * It reuses the rig of test/batched-wake-locus.test.ts at 220f4cffe, copied
 * unchanged below, and logs what each rule leaves in the window, what it
 * publishes and the route-failed traces. It asserts nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { conversationForkSpec } from '../src/dendrite/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const RAW_DM = '1548000000000000001';
const DM = `discord:dm:${RAW_DM}`;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function batchedWakeRig(speech?: { locus: 'delivery' | 'latest-inbound' }) {
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-locus-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      ...(speech ? { speech } : {}),
      gate: {
        config: {
          policies: [{
            name: 'batch',
            match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] },
            behavior: { debounce: 400 },
          }],
          default: 'skip',
        },
      },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  const dm = (text: string): void => command(`dm ev-${++n} 134 ${RAW_DM} ${text}`);
  const incoming = (channelId: string, mode: 'ambient' | 'addressed', text: string): void =>
    command(`incoming ${channelId} m-${++n} ${mode} ${text}`);
  const sent = (event: string): number => !existsSync(statusPath) ? 0
    : readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .filter((l) => (JSON.parse(l) as { event: string }).event === event).length;
  const publishes = (): string[] => !existsSync(statusPath) ? []
    : readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; channelId?: string })
      .filter((e) => e.event === 'publish')
      .map((e) => e.channelId!);

  return {
    membrane: () => membrane,
    framework: () => framework,
    dm, incoming, sent, publishes,
  };
}


for (const rule of ['delivery', 'latest-inbound'] as const) {
  describe(`PROBE under speech.locus '${rule}'`, () => {
    const rig = batchedWakeRig({ locus: rule });
    const { incoming, sent, publishes } = rig;
    it(`PROBE ${rule}: an addressed turn, then an ambient-only batch`, async () => {
      const traces: Array<{ type: string; reason?: string }> = [];
      rig.framework().onTrace((e) => { traces.push(e as { type: string; reason?: string }); });
      rig.membrane().pushResponse(createMockResponse([{ type: 'text', text: 'answering the mention' }]));
      incoming(ROOM, 'addressed', '@scout hello');
      await waitFor(() => publishes().length >= 1, 'first reply published');
      await rig.framework().runUntilIdle();
      rig.membrane().pushResponse(createMockResponse([{ type: 'text', text: 'joining in' }]));
      incoming(ROOM, 'ambient', 'first');
      await waitFor(() => sent('incoming-sent') === 2, 'ambient sent');
      incoming(GENERAL, 'ambient', 'second');
      await waitFor(() => rig.membrane().calls.length >= 2, 'the batch woke the agent');
      await rig.framework().runUntilIdle();
      await new Promise((r) => setTimeout(r, 300));
      const msgs = rig.framework().getAgent('scout')!.getContextManager().getAllMessages();
      for (const m of msgs) {
        const t = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' | ');
        const meta = m as unknown as { participant?: string; metadata?: { kind?: string } };
        console.log(`PROBE ${rule} WINDOW ${meta.participant ?? ''} [${meta.metadata?.kind ?? ''}]: ${t.slice(0, 260)}`);
      }
      console.log(`PROBE ${rule} PUBLISHES ${JSON.stringify(publishes())}`);
      const failed = traces.filter((t) => t.type === 'mcpl:speech-route-failed');
      console.log(`PROBE ${rule} ROUTE-FAILED ${failed.length} ${JSON.stringify(failed.map((t) => t.reason))}`);
    });
  });
}
