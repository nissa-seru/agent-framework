import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { ConversationContext, DiscordClientInterface } from '../src/modules/discord/types.js';
import type { SpeechContext } from '../src/types/index.js';

// On a turn with tool calls, the framework hands the Discord module the turn's
// text as `thoughts`, and the module edits them, as a spoiler, into the message
// the latest attempt to post produced. An attempt that posted nothing, or a DM,
// leaves no message for them: the message posted before it, which people may
// already have read, isn't edited.

const agentName = 'assistant';
const trigger = { reason: 'test', source: 'test', timestamp: 0 };
const toolTurnEnd: SpeechContext = {
  turnComplete: true,
  trigger,
  thoughts: [{ type: 'text', text: 'why' }],
};
const textTurn: SpeechContext = { turnComplete: true, trigger };

function setup(rateLimitPerMinute?: number) {
  let n = 0;
  const posted = new Map<string, string>();
  const edits: string[] = [];
  const failures = { send: false };
  const client = {
    sendMessage: async (_channelId: string, content: string) => {
      if (failures.send) {
        failures.send = false;
        throw new Error('Missing Permissions');
      }
      const messageId = `M${++n}`;
      posted.set(messageId, content);
      return { messageId };
    },
    sendDM: async (_userId: string, content: string) => {
      const messageId = `D${++n}`;
      posted.set(messageId, content);
      return { messageId };
    },
    fetchMessage: async (_channelId: string, messageId: string) => posted.get(messageId) ?? '',
    editMessage: async (_channelId: string, messageId: string, content: string) => {
      edits.push(`${messageId}: ${content}`);
    },
  } as unknown as DiscordClientInterface;
  const module = new DiscordModule(client, { token: 'test-token', rateLimitPerMinute });
  const replyContexts = (module as unknown as { replyContexts: Map<string, ConversationContext> }).replyContexts;
  replyContexts.set('default', { channelId: 'c1', userId: 'u1' } as ConversationContext);
  const tool = (name: string, input: unknown) => module.handleToolCall({ id: `call-${name}` as never, name, input });
  return { module, edits, failures, replyContexts, tool };
}

const attempts: Array<{
  name: string;
  rateLimitPerMinute?: number;
  attempt: (s: ReturnType<typeof setup>) => Promise<void>;
}> = [
  {
    name: 'a send that throws',
    attempt: async ({ tool, failures }) => {
      failures.send = true;
      assert.equal((await tool('send', { channelId: 'c1', content: 'second' })).success, false);
    },
  },
  {
    name: 'a send refused by the rate limit',
    rateLimitPerMinute: 1,
    attempt: async ({ tool }) => {
      assert.equal((await tool('send', { channelId: 'c1', content: 'second' })).error, 'Rate limited');
    },
  },
  {
    name: 'a reply that throws',
    attempt: async ({ tool, failures }) => {
      failures.send = true;
      assert.equal((await tool('reply', { content: 'second' })).success, false);
    },
  },
  {
    name: 'a reply refused for want of a reply context',
    attempt: async ({ tool, replyContexts }) => {
      replyContexts.delete('default');
      assert.equal((await tool('reply', { content: 'second' })).error, 'No conversation context');
    },
  },
  {
    name: 'a DM that posts',
    attempt: async ({ tool }) => {
      assert.equal((await tool('dm', { userId: 'u1', content: 'second' })).success, true);
    },
  },
  {
    name: "the module's own speech send that throws",
    attempt: async ({ module, failures }) => {
      failures.send = true;
      await assert.rejects(module.onAgentSpeech(agentName, [{ type: 'text', text: 'second' }], textTurn), /Missing Permissions/);
    },
  },
  {
    name: "the module's own speech refused by the rate limit",
    rateLimitPerMinute: 1,
    attempt: async ({ module }) => {
      await module.onAgentSpeech(agentName, [{ type: 'text', text: 'second' }], textTurn);
    },
  },
];

for (const { name, rateLimitPerMinute, attempt } of attempts) {
  test(`after ${name}, the turn's thoughts are edited into no earlier message`, async () => {
    const s = setup(rateLimitPerMinute);
    assert.equal((await s.tool('send', { channelId: 'c1', content: 'first' })).success, true);
    await attempt(s);
    await s.module.onAgentSpeech(agentName, [], toolTurnEnd);
    assert.deepEqual(s.edits, []);
  });
}

test("a send that posts takes the turn's thoughts", async () => {
  const s = setup();
  await s.tool('send', { channelId: 'c1', content: 'first' });
  await s.tool('send', { channelId: 'c1', content: 'second' });
  await s.module.onAgentSpeech(agentName, [], toolTurnEnd);
  assert.deepEqual(s.edits, ['M2: ||why||\nsecond']);
});
