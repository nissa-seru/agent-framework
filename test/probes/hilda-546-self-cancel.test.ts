/**
 * Probe S7 for #546's review: a cancel the subconscious makes itself, with
 * no note, at backlogCap 0, over two tuned-out messages already stored. At
 * backlogCap 0 the tune_out tool says the subconscious's report is the
 * whole delivery; this shows what the resident's dump carries and whether
 * the subconscious is handed a report notice.
 *
 * Logs a PROBE-S7 line and asserts what it shows at this head.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../../src/index.js';
import { MockMembrane, createMockResponse } from '../helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../../src/tune-out/coordinator.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: ContentBlock[] }> } }>;
  deferredMessages: Array<{ content: ContentBlock[] }>;
  channelRegistry: { listChannelsRaw(): unknown[] } | null;
}

const textOf = (m: { content: ContentBlock[] }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('probe S7: a cancel the subconscious makes itself, with no note, at backlogCap 0', () => {
  it('S7: the dump counts both stored messages and shows neither; the subconscious gets no report notice', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'probe-546-self-cancel-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
      mcplServers: [{
        id: 'disc',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    try {
      await framework.start();
      const i = framework as unknown as Internals;
      await waitFor('channel registration', () => (i.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
      assert.ok(i.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 0, maxWakes: 5 }, 'agent-tool').ok);

      const scout = i.agents.get('scout')!.getContextManager();
      const stored = (tag: string): boolean => scout.getAllMessages().some((m) => textOf(m).includes(tag));
      appendFileSync(commandPath, 'ambient s7a S7-STORED-1 chatter in the tuned-out channel\n');
      await waitFor('the first stored', () => stored('S7-STORED-1'));
      appendFileSync(commandPath, 'ambient s7b S7-STORED-2 more chatter in the tuned-out channel\n');
      await waitFor('the second stored', () => stored('S7-STORED-2'));

      // The resident's turn the cancel requests gets a reply, so it ends.
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
      // The cancel cancel_tuneout makes, in the subconscious's name, with no note.
      assert.ok(i.tuneOutCoordinator!.cancel('disc', CHANNEL, 'subconscious', 'subconscious judgment', undefined).ok);
      const dumpOf = (): string | undefined =>
        [...scout.getAllMessages(), ...i.deferredMessages].map(textOf).find((t) => t.includes('<tuned-out-backlog'));
      await waitFor('the dump', () => dumpOf() !== undefined);
      const sub = i.agents.get('Subconscious')!.getContextManager();
      const noticeOf = (): string | undefined => sub.getAllMessages().map(textOf).find((t) => t.includes('[Tune-out cancelled:'));
      // A notice is added in the same call as the dump, so a short wait is
      // ample for one that would come.
      await new Promise((r) => setTimeout(r, 1_000));
      const dump = dumpOf()!;
      const notice = noticeOf();
      const counts = /messages=(\d+) truncated=(\d+)/.exec(dump);
      console.log(`# PROBE-S7 ${JSON.stringify({ counts: counts?.[0] ?? null, dumpShows1: dump.includes('S7-STORED-1'), dumpShows2: dump.includes('S7-STORED-2'), notice: notice ?? null })}`);
      assert.ok(dump.includes('messages=2 truncated=2'), 'the dump counts both stored messages');
      assert.ok(!dump.includes('S7-STORED-1') && !dump.includes('S7-STORED-2'), 'and shows neither');
      assert.equal(notice, undefined, 'the subconscious is handed no report notice');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
