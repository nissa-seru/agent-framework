import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { answerText, scriptCall } from './helpers/script-call.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

interface Internals {
  channelRegistry: {
    listChannelsRaw(): Array<{ serverId: string; descriptor: { id: string } }>;
    getTuneOutState(serverId: string, channelId: string): unknown;
  };
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }> } }>;
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

async function tunedOutThenRemoved(t: { after(fn: () => Promise<void>): void }, servers: string[], held: string[], removing = servers) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-unconnected-'));
  const commands = new Map(servers.map((id) => [id, join(tempDir, `commands-${id}.txt`)]));
  for (const path of commands.values()) writeFileSync(path, '');
  const fw = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: servers.map((id) => ({ id, command: process.execPath, args: [FIXTURE], env: { COMMAND_PATH: commands.get(id)! } })),
    modules: [],
  });
  t.after(async () => { await fw.stop(); rmSync(tempDir, { recursive: true, force: true }); });
  const i = fw as unknown as Internals;
  await fw.start();
  await waitFor(() => i.channelRegistry.listChannelsRaw().length === servers.length, 'registration');
  const call = async (input: Record<string, unknown>) => {
    const answer = await scriptCall(fw, 'scout', 'tune_out', input);
    return { text: answerText(answer), isError: answer.refused || answer.isError };
  };
  for (const serverId of servers) {
    const entered = await call({ channelId: CHANNEL, serverId, cadenceSeconds: 3600 });
    assert.equal(entered.isError, false, entered.text);
  }
  const scout = i.agents.get('scout')!.getContextManager();
  const stamped = () => scout.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length;
  for (const path of commands.values()) held.forEach((text, n) => appendFileSync(path, `ambient m${n + 1} ${text}\n`));
  await waitFor(() => stamped() === held.length * servers.length, 'the held messages');
  for (const id of removing) appendFileSync(commands.get(id)!, 'remove\n');
  await waitFor(() => i.channelRegistry.listChannelsRaw().length === servers.length - removing.length, 'the removal');
  return { i, scout, call };
}

test("tune_out's check lists a tune-out whose channel was removed, as not connected, with the label it was last seen with", async (t) => {
  const f = await tunedOutThenRemoved(t, ['disc'], ['first held', 'second held']);
  const checked = await f.call({ mode: 'check' });
  assert.equal(checked.isError, false, checked.text);
  const { channels } = JSON.parse(checked.text) as { channels: Array<Record<string, unknown>> };
  assert.deepEqual(channels.map(({ epochId: _epochId, ...rest }) => rest), [
    { serverId: 'disc', channelId: CHANNEL, held: 2, connected: false, lastSeenLabel: 'noisy' },
  ]);
});

test("tune_out's peek shows what a tune-out whose channel was removed holds, by the channel's id", async (t) => {
  const f = await tunedOutThenRemoved(t, ['disc'], ['first held', 'second held']);
  const peeked = await f.call({ mode: 'check', peek: CHANNEL });
  assert.equal(peeked.isError, false, peeked.text);
  const { peek } = JSON.parse(peeked.text) as { peek: string[] };
  assert.equal(peek.length, 2, peeked.text);
  assert.ok(peek[0]!.includes('first held') && peek[1]!.includes('second held'), peeked.text);
});

test("tune_out's cancel ends a tune-out whose channel was removed, by the channel's id, and delivers its backlog", async (t) => {
  const f = await tunedOutThenRemoved(t, ['disc'], ['first held', 'second held']);
  const byLabel = await f.call({ mode: 'cancel', channelId: 'noisy' });
  assert.equal(byLabel.isError, true, 'a label is not a name the cancel takes');
  assert.ok(f.i.channelRegistry.getTuneOutState('disc', CHANNEL));
  const cancelled = await f.call({ mode: 'cancel', channelId: CHANNEL });
  assert.equal(cancelled.isError, false, cancelled.text);
  assert.equal(f.i.channelRegistry.getTuneOutState('disc', CHANNEL), null);
  const dump = f.scout.getAllMessages().map(textOf).find((text) => text.includes('<tuned-out-backlog'));
  assert.ok(dump?.includes('first held') && dump.includes('second held'), dump);
  const after = JSON.parse((await f.call({ mode: 'check' })).text) as { channels: unknown[] };
  assert.deepEqual(after.channels, []);
});

test('an id two tune-outs share once their channels are removed is refused with a name for each, and that name, or the id with a serverId, picks the one it names', async (t) => {
  const f = await tunedOutThenRemoved(t, ['disc', 'disc2'], ['held on both']);
  const refused = await f.call({ mode: 'cancel', channelId: CHANNEL });
  assert.equal(refused.isError, true);
  assert.ok(refused.text.includes('channelId "disc:disc:guild:noisy"') && refused.text.includes('channelId "disc2:disc:guild:noisy"'), refused.text);
  const unpeeked = await f.call({ mode: 'check', peek: CHANNEL });
  assert.equal(unpeeked.isError, true);
  assert.ok(unpeeked.text.includes('peek "disc:disc:guild:noisy"') && unpeeked.text.includes('peek "disc2:disc:guild:noisy"'), unpeeked.text);
  assert.ok(f.i.channelRegistry.getTuneOutState('disc', CHANNEL) && f.i.channelRegistry.getTuneOutState('disc2', CHANNEL), 'neither is cancelled');
  const peeked = await f.call({ mode: 'check', peek: `disc2:${CHANNEL}` });
  assert.equal(peeked.isError, false, peeked.text);
  assert.equal((JSON.parse(peeked.text) as { peek: string[] }).peek.length, 1, peeked.text);
  const byName = await f.call({ mode: 'cancel', channelId: `disc:${CHANNEL}` });
  assert.equal(byName.isError, false, byName.text);
  assert.equal(f.i.channelRegistry.getTuneOutState('disc', CHANNEL), null);
  assert.ok(f.i.channelRegistry.getTuneOutState('disc2', CHANNEL), "disc2's goes on");
  const byServer = await f.call({ mode: 'cancel', channelId: CHANNEL, serverId: 'disc2' });
  assert.equal(byServer.isError, false, byServer.text);
  assert.equal(f.i.channelRegistry.getTuneOutState('disc2', CHANNEL), null);
});

test("an id a registered channel answers to still means that channel, though a tune-out whose channel was removed shares it", async (t) => {
  const f = await tunedOutThenRemoved(t, ['disc', 'disc2'], ['held on both'], ['disc']);
  const cancelled = await f.call({ mode: 'cancel', channelId: CHANNEL });
  assert.equal(cancelled.isError, false, cancelled.text);
  assert.equal(f.i.channelRegistry.getTuneOutState('disc2', CHANNEL), null, "disc2's channel is registered, so the id means it");
  assert.ok(f.i.channelRegistry.getTuneOutState('disc', CHANNEL), "disc's goes on");
});
