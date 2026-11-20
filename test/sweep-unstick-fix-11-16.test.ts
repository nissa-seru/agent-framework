import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { MessageId, StoredMessage, SweepBody, SweepEntry } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { UNSTICK_FIX_11_16 } from '../src/sweep-unstick-fix-11-16.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const NAME = 'unstick-fix-11-16';
const FAILURE_ADVICE = 'If this recurs with the same cause, change approach rather than retrying identically ' +
  '(e.g. drop an oversized attachment or an unsupported setting).';
const TIMEOUT_ADVICE = 'If a reply is still owed from that turn, you can give it now.';
const CLEAR = 'You are clear to continue — if you were mid-task, take a different approach; otherwise carry on with ' +
  'whatever is now in front of you, or briefly acknowledge the gap and ask what\'s next.';
const SET_ASIDE = (count: string) => `${count} were set aside because the requests that carried them couldn't be ` +
  `completed. Their content isn't shown here, and the originals remain in the raw record. ${CLEAR}`;
const PROVIDER = 'ZQ-PROVIDER says no. Reason: zq-inner. Another sentence.';
const OLD_REWIND = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model refused on them (content ' +
  'filter: zq-cat). Their content is not reproduced here (so this note can\'t re-trigger the filter); the originals ' +
  `remain in the raw record. ${CLEAR}`;
const OLD_FAILED = '[inference-failed] Your previous turn did not complete: the model call failed (invalid_request, ' +
  `HTTP 400) and produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
const REWIND_STAMPS = { system: true, kind: 'refusal-rewind', category: 'zq-cat', count: 1, cause: 'refusal' };
const FAILED_STAMPS = { system: true, kind: 'inference-failed', reason: PROVIDER, consecutive: 1 };
const LEAKS = ['zq-cat', 'content filter', 'ZQ-PROVIDER', 'zq-inner'];

let made = 0;
function body(text: string, metadata?: Record<string, unknown>, content?: SweepBody['content']): SweepBody {
  made += 1;
  return {
    id: `row-${made}`,
    participant: 'user',
    timestamp: new Date(made),
    ...(metadata !== undefined ? { metadata } : {}),
    content: content ?? [{ type: 'text', text }],
  };
}
const rewind = (text: string) => body(text, REWIND_STAMPS);
const failed = (text: string, stamps: Record<string, unknown> = FAILED_STAMPS) => body(text, stamps);

function mended(entry: SweepEntry, given: SweepBody): string | null {
  const content = entry.mend(given);
  if (content === null) return null;
  assert.equal(content.length, 1, 'a mended note is one text block');
  const [block] = content;
  assert.ok(block !== undefined && block.type === 'text', 'a mended note is one text block');
  return block.text;
}
const rewritten = (given: SweepBody) => mended(UNSTICK_FIX_11_16, given);

describe('unstick-fix-11-16: the notes that agent-framework 0.33.1 and earlier wrote', () => {
  it('U1: a rewind note for a refusal, 0.6.2 to 0.33.1, keeps its tag and the count its text gives, and loses the category', () => {
    const old = '[refusal-rewind] The 3 most recent turn(s) were set aside because the model refused on them (content ' +
      'filter: zq-cat). Their content is not reproduced here (so this note can\'t re-trigger the filter); the ' +
      `originals remain in the raw record. ${CLEAR}`;
    assert.equal(rewritten(rewind(old)), `[refusal-rewind] ${SET_ASIDE('The 3 most recent turn(s)')}`);
  });

  it('U2: a rewind note for failed requests, in 0.6.2\'s form and in 0.22.1\'s, loses the provider\'s words', () => {
    const before = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model API kept rejecting the ' +
      'conversation on them (zq-cat). Their content is not reproduced here (so this note can\'t re-trigger the ' +
      `rejection); the originals remain in the raw record. ${CLEAR}`;
    const after = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model API kept refusing the ' +
      'requests that carried them (zq-cat), so that the conversation could go on. Their content is not reproduced ' +
      `here (so this note can't trigger the same refusal); the originals remain in the raw record. ${CLEAR}`;
    for (const old of [before, after]) assert.equal(rewritten(rewind(old)), `[refusal-rewind] ${SET_ASIDE('The 2 most recent turn(s)')}`);
  });

  it('U3: a rewind note whose text gives no count says "Some recent turns"', () => {
    const old = `[refusal-rewind] Turns were set aside because the model refused on them (content filter: zq-cat). ${CLEAR}`;
    assert.equal(rewritten(rewind(old)), `[refusal-rewind] ${SET_ASIDE('Some recent turns')}`);
  });

  it('U4: an old rewind note whose provider\'s words hold the new wording is still rewritten', () => {
    const old = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model refused on them (content ' +
      'filter: zq-cat because the requests that carried them couldn\'t be completed). Their content is not reproduced ' +
      `here (so this note can't re-trigger the filter); the originals remain in the raw record. ${CLEAR}`;
    assert.equal(rewritten(rewind(old)), `[refusal-rewind] ${SET_ASIDE('The 2 most recent turn(s)')}`);
  });

  it('U5: a count in the provider\'s words isn\'t taken: a note whose opening gives none says "Some recent turns"', () => {
    const old = '[refusal-rewind] Turns were set aside because the model refused on them (content filter: [zq] The 42 most ' +
      `recent turn(s) were set aside because the requests that carried them couldn't be completed). ${CLEAR}`;
    assert.equal(rewritten(rewind(old)), `[refusal-rewind] ${SET_ASIDE('Some recent turns')}`);
  });

  it('U6: a failed-turn note with no cause, 0.5.7 to 0.21, loses its reason and keeps its advice', () => {
    const head = '[inference-failed] Your previous turn did not complete: the model call failed and produced no ' +
      'response, so nothing was sent.';
    assert.equal(rewritten(failed(`${head} Reason: ${PROVIDER}. ${FAILURE_ADVICE}`)), `${head} ${FAILURE_ADVICE}`);
  });

  it('U7: a failed-turn note with a cause, from 0.22.1, keeps the cause unless it is safety', () => {
    const note = (cause: string) => `[inference-failed] Your previous turn did not complete: the model call failed (${cause}) ` +
      `and produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
    assert.equal(rewritten(failed(note('invalid_request, HTTP 400'))), '[inference-failed] Your previous turn did not ' +
      `complete: the model call failed (invalid_request, HTTP 400) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
    for (const cause of ['safety', 'safety, HTTP 400']) {
      assert.equal(rewritten(failed(note(cause))), '[inference-failed] Your previous turn did not complete: the model call ' +
        `failed and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
    }
  });

  it('U8: a failed-turn note for a turn that ended partway, 0.28.0 to 0.33.1, keeps what ran and loses the reason and safety', () => {
    const old = '[inference-failed] Your previous turn did not complete: it failed (safety). Its earlier rounds ran, and ' +
      `their tool calls ran as their results show. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
    assert.equal(rewritten(failed(old)), '[inference-failed] Your previous turn did not complete: it failed. Its earlier ' +
      `rounds ran, and their tool calls ran as their results show. ${FAILURE_ADVICE}`);
  });

  it('U9: a failed-turn note for a timeout, from 0.31.0, keeps its own advice', () => {
    const head = '[inference-failed] Your previous turn did not complete: the model call timed out and produced no ' +
      'response, so nothing was sent. The call was made again, and it timed out again.';
    assert.equal(rewritten(failed(`${head} Reason: ${PROVIDER}. ${TIMEOUT_ADVICE}`)), `${head} ${TIMEOUT_ADVICE}`);
  });

  it('U10: a failed-turn note for a turn whose last call timed out partway, 0.33.0 and 0.33.1, keeps what ran and its own advice', () => {
    const head = '[inference-failed] Your previous turn did not complete: its last call timed out (timeout, HTTP 408). ' +
      'Its earlier rounds ran, and their tool calls ran as their results show.';
    assert.equal(rewritten(failed(`${head} Reason: ${PROVIDER}. ${TIMEOUT_ADVICE}`)), `${head} ${TIMEOUT_ADVICE}`);
  });

  it('U11: a provider message holding "Reason:" and two sentence ends leaves nothing of itself', () => {
    const out = rewritten(failed('[inference-failed] Your previous turn did not complete: the model call failed and ' +
      `produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`));
    assert.ok(out !== null);
    for (const piece of ['ZQ-PROVIDER', 'zq-inner', 'Another sentence', 'Reason:']) assert.ok(!out.includes(piece), piece);
  });

  it('U12: a provider message of a megabyte, as one body, leaves nothing of itself', () => {
    const echo = `zz-head ${'e'.repeat(1_000_000)} zz-tail`;
    const head = '[inference-failed] Your previous turn did not complete: the model call failed (invalid_request, HTTP 400) ' +
      'and produced no response, so nothing was sent.';
    assert.equal(rewritten(failed(`${head} Reason: ${echo}. ${FAILURE_ADVICE}`, { ...FAILED_STAMPS, reason: echo })), `${head} ${FAILURE_ADVICE}`);
  });
});

describe('unstick-fix-11-16: what it leaves', () => {
  it('U13: a rewind note in 0.33.2\'s form or a later one is left, whatever its tag', () => {
    assert.equal(rewritten(rewind(`[refusal-rewind] ${SET_ASIDE('The 1 most recent turn(s)')}`)), null);
    assert.equal(rewritten(rewind(`[turns-set-aside] ${SET_ASIDE('The 1 most recent turn(s)')}`)), null);
    assert.equal(rewritten(rewind(`[refusal-rewind] ${SET_ASIDE('Some recent turns')}`)), null);
  });

  it('U14: a failed-turn note whose text holds no "Reason:" is left: 0.33.2\'s and 0.35.0\'s', () => {
    assert.equal(rewritten(failed('[inference-failed] Your previous turn did not complete: the model call failed and ' +
      `produced no response, so nothing was sent. ${FAILURE_ADVICE}`)), null);
    assert.equal(rewritten(failed('[inference-failed] Your previous turn did not complete: it failed (invalid_request, ' +
      'HTTP 400). Its earlier rounds ran, and their tool calls ran as their results show.',
    { ...FAILED_STAMPS, errorType: 'invalid_request', httpStatus: 400 })), null);
  });

  describe('a failed-turn note whose reason agent-framework 0.33.3 writes itself, whichever release wrote it', () => {
    const FAILED = '[inference-failed] Your previous turn did not complete: the model call failed';
    const BOUND = 'No content within 0.3s of the send (the host\'s setting for this bound: ' +
      '`inferenceBounds.progressBounds.beforeContentMs`)';
    const note = (text: string, metadata: Record<string, unknown>) =>
      body(text, { system: true, kind: 'inference-failed', consecutive: 1, ...metadata });

    it('U15: a progress bound\'s cut, in 0.33.3\'s form and in 0.35.0\'s', () => {
      const text = '[inference-failed] Your previous turn did not complete: the model call timed out and produced no ' +
        `response, so nothing was sent. The call was made again, and it timed out again. Reason: ${BOUND}. ${TIMEOUT_ADVICE}`;
      assert.equal(rewritten(note(text, { reason: BOUND, errorType: 'timeout', retryable: false })), null);
      const think = 'No content within 2s of a thinking block\'s start (max_tokens 8000 at 50 tokens a second) (the ' +
        'host\'s setting for this bound: `inferenceBounds.progressBounds.thinkTokensPerSecond`)';
      assert.equal(rewritten(note(text.replace(BOUND, think), { reason: think, errorType: 'timeout' })), null);
      const flat = 'The provider made no progress within the call\'s bound';
      const later = '[inference-failed] Your previous turn did not complete: its last call timed out. Its earlier rounds ' +
        `ran, and their tool calls ran as their results show. Reason: ${flat}. ${TIMEOUT_ADVICE}`;
      assert.equal(rewritten(note(later, { reason: flat, errorType: 'timeout', retryable: false })), null);
    });

    it('U16: a compile that context-manager refused, in 0.33.3\'s form and as 0.33.1 wrote it', () => {
      const reason = 'Context would exceed hard budget';
      for (const errorType of ['over_budget', 'context_refusal']) {
        const text = `${FAILED} (${errorType}) and produced no response, so nothing was sent. Reason: ${reason}. ${FAILURE_ADVICE}`;
        assert.equal(rewritten(note(text, { reason, errorType })), null);
      }
    });

    it('U17: a stream\'s abort, which carries no error type', () => {
      const reason = 'Stream aborted: stopped by operator';
      const text = `[inference-failed] Your previous turn did not complete: it failed. Reason: ${reason}. ${FAILURE_ADVICE}`;
      assert.equal(rewritten(note(text, { reason })), null);
    });

    it('U18: where the stored fields show no such reason, the note is mended: a provider\'s timeout, a provider\'s message that opens like an abort or a cut, and a note with no stored reason', () => {
      const timeout = '[inference-failed] Your previous turn did not complete: the model call timed out (timeout, HTTP 408) ' +
        `and produced no response, so nothing was sent. Reason: ${PROVIDER}. ${TIMEOUT_ADVICE}`;
      assert.equal(rewritten(note(timeout, { reason: PROVIDER, errorType: 'timeout', httpStatus: 408 })), '[inference-failed] ' +
        'Your previous turn did not complete: the model call timed out (timeout, HTTP 408) and produced no response, so ' +
        `nothing was sent. ${TIMEOUT_ADVICE}`);
      const planted = 'Stream aborted: ZQ-PROVIDER says no';
      const asAbort = `${FAILED} (invalid_request, HTTP 400) and produced no response, so nothing was sent. Reason: ${planted}. ${FAILURE_ADVICE}`;
      assert.equal(rewritten(note(asAbort, { reason: planted, errorType: 'invalid_request', httpStatus: 400 })),
        `${FAILED} (invalid_request, HTTP 400) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
      const asCut = `${FAILED} (server, HTTP 500) and produced no response, so nothing was sent. Reason: ${BOUND}. ${FAILURE_ADVICE}`;
      assert.equal(rewritten(note(asCut, { reason: BOUND, errorType: 'server', httpStatus: 500 })),
        `${FAILED} (server, HTTP 500) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
      const noReason = `${FAILED} (over_budget) and produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
      assert.equal(rewritten(note(noReason, { errorType: 'unknown' })),
        `${FAILED} (over_budget) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
      const bare = `[inference-failed] Your previous turn did not complete: it failed. Reason: ${BOUND}. ${FAILURE_ADVICE}`;
      assert.equal(rewritten(note(bare, {})), `[inference-failed] Your previous turn did not complete: it failed. ${FAILURE_ADVICE}`);
    });
  });

  it('U19: a body by another writer that quotes the old notes is left: no stamps, one stamp, or another kind', () => {
    const words = `I read the notes. ${OLD_REWIND} ${OLD_FAILED}`;
    assert.equal(rewritten(body(words)), null);
    assert.equal(rewritten(body(words, {})), null);
    assert.equal(rewritten(body(OLD_FAILED, { kind: 'inference-failed', reason: PROVIDER })), null);
    assert.equal(rewritten(body(OLD_REWIND, { kind: 'refusal-rewind', category: 'zq-cat' })), null);
    assert.equal(rewritten(body(OLD_FAILED, { system: true, kind: 'other' })), null);
    assert.equal(rewritten(body(OLD_FAILED, { system: 'true', kind: 'inference-failed' })), null);
  });

  it('U20: a stamped body that holds a block other than one text is left, since the framework wrote no such note', () => {
    const image: SweepBody['content'][number] = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } };
    assert.equal(rewritten(body(OLD_FAILED, FAILED_STAMPS, [{ type: 'text', text: OLD_FAILED }, image])), null);
    assert.equal(rewritten(body(OLD_REWIND, REWIND_STAMPS, [image, { type: 'text', text: OLD_REWIND }])), null);
    assert.equal(rewritten(body(OLD_FAILED, FAILED_STAMPS, [{ type: 'text', text: OLD_FAILED }, { type: 'text', text: ' more' }])), null);
  });
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

class Surface implements Module {
  readonly name = 'surface';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'look', description: 'Look at something.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'what the tool saw' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [text(String(event.content))] }], requestInference: true };
  }
}

class ToolRoundThenError implements YieldingStream {
  isCancelled = false;
  toolDepth = 0;
  private waiting = true;
  private resume?: () => void;
  constructor(private readonly error: Error) {}
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds() { return this.waiting ? ['zq-call'] : []; }
  provideToolResults(): void { this.waiting = false; this.toolDepth = 1; this.resume?.(); }
  cancel(): void { this.isCancelled = true; this.waiting = false; this.resume?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const call = { id: 'zq-call', name: 'surface--look', input: {} };
    yield { type: 'tool-calls', calls: [call], context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
      roundContent: [{ type: 'tool_use', ...call }], supportsInjectedMessages: true } } as StreamEvent;
    if (this.waiting) await new Promise<void>((resolve) => { this.resume = resolve; });
    if (this.isCancelled) return;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

type Step = 'ok' | 'refuse' | 'fail';

class ScriptedMembrane extends MockMembrane {
  readonly script: Step[] = [];
  readonly requests: NormalizedRequest[] = [];
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.requests.push(structuredClone(request));
    const step = this.script.shift() ?? 'ok';
    if (step === 'fail') {
      return new ToolRoundThenError(new MembraneError({ type: 'invalid_request', retryable: false, httpStatus: 400, rawError: undefined, message: PROVIDER }));
    }
    const response: NormalizedResponse = step === 'refuse'
      ? { ...createMockResponse([], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'zq-cat' } } } } as unknown as NormalizedResponse
      : createMockResponse([text('answers')]);
    this.pushResponse(response);
    return super.streamYielding(request, options);
  }
}

async function residentWithNotes() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-unstick-'));
  const membrane = new ScriptedMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout', refusalHandling: { autoRewind: true, maxRewinds: 3 } }],
    modules: [new Surface()],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    syncIntervalMs: 0, maintenanceIntervalMs: 0,
  } as never);
  const quiet = console.error;
  const close = async () => { console.error = quiet; await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  console.error = () => {};
  try {
    const say = async (content: string, steps: Step[], until: number) => {
      membrane.script.push(...steps);
      framework.pushEvent({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true } as never);
      for (let i = 0; i < 300 && membrane.requests.length < until; i++) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
      assert.ok(membrane.requests.length >= until, `the membrane got ${membrane.requests.length} requests, not ${until}`);
      await framework.runUntilIdle();
    };
    await say('first question. Reason: a person\'s own words.', ['ok'], 1);
    await say('second question', ['refuse', 'ok'], 3);
    await say('third question', ['fail'], 4);
    await say('fourth question', ['ok'], 5);
    const cm = framework.getAgent('scout')!.getContextManager();
    const rows = () => cm.getAllMessages();
    const kindOf = (row: StoredMessage) => row.metadata?.kind;
    const native = rows().filter((row) => kindOf(row) === 'refusal-rewind' || kindOf(row) === 'inference-failed');
    const old = [
      cm.addMessage('user', [text(OLD_REWIND)], { ...REWIND_STAMPS }),
      cm.addMessage('user', [text(OLD_FAILED)], { ...FAILED_STAMPS, errorType: 'invalid_request', httpStatus: 400 }),
    ];
    const textAt = (id: MessageId) => {
      const row = rows().find((each) => each.id === id);
      assert.ok(row, `row ${id} is stored`);
      return row.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    };
    const nextRequest = async () => {
      await say('fifth question', ['ok'], membrane.requests.length + 1);
      return JSON.stringify(membrane.requests.at(-1));
    };
    return { framework, native, old, textAt, rows, nextRequest, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe('unstick-fix-11-16 through the framework', () => {
  it('U21: the framework lists the entry, and a host entry of its name refuses create()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-unstick-'));
    try {
      const framework = await AgentFramework.create({
        storePath: join(dir, 'a'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [],
      });
      try {
        assert.deepEqual(framework.listSweeps().find((each) => each.name === NAME), { name: NAME, line: UNSTICK_FIX_11_16.line });
      } finally { await framework.stop(); }
      const own: SweepEntry = { name: NAME, line: 'a host\'s own', mend: () => null };
      await assert.rejects(AgentFramework.create({
        storePath: join(dir, 'b'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [], sweeps: [own],
      }), /The framework has a sweep entry named "unstick-fix-11-16"/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('U22: the old notes are shown, then rewritten, and the next request holds no provider\'s words; the notes this framework wrote and a person\'s message are left', async () => {
    const r = await residentWithNotes();
    try {
      const kinds = r.native.map((row) => row.metadata?.kind).sort();
      assert.deepEqual(kinds, ['inference-failed', 'refusal-rewind'], 'premise: this framework wrote one note of each kind');
      const nativeBefore = r.native.map((row) => r.textAt(row.id));
      assert.ok(nativeBefore.some((t) => t.startsWith('[turns-set-aside] The 1 most recent turn(s)')), nativeBefore.join('\n'));
      assert.ok(nativeBefore.some((t) => t.startsWith('[inference-failed] Your previous turn did not complete: it failed (invalid_request, HTTP 400).')), nativeBefore.join('\n'));
      const person = r.rows().find((row) => r.textAt(row.id).startsWith('first question.'));
      assert.ok(person, 'premise: the person\'s message is stored');
      const personBefore = r.textAt(person.id);

      const shown = r.framework.showSweep(NAME);
      assert.deepEqual(shown.changes.map((change) => change.id).sort(), [...r.old].sort(), 'the show lists the old notes alone');
      assert.deepEqual(r.old.map(r.textAt), [OLD_REWIND, OLD_FAILED], 'the show wrote nothing');

      const written = await r.framework.takeSweep(NAME);
      assert.equal(written.outcome, 'finished');
      assert.equal(r.textAt(r.old[0]!), `[refusal-rewind] ${SET_ASIDE('The 2 most recent turn(s)')}`);
      assert.equal(r.textAt(r.old[1]!), '[inference-failed] Your previous turn did not complete: the model call failed ' +
        `(invalid_request, HTTP 400) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
      assert.deepEqual(r.native.map((row) => r.textAt(row.id)), nativeBefore, 'the notes this framework wrote are left');
      assert.equal(r.textAt(person.id), personBefore, 'the person\'s message is left');

      const next = await r.nextRequest();
      for (const leak of LEAKS) assert.ok(!next.includes(leak), leak);
      assert.ok(next.includes('The 2 most recent turn(s) were set aside because the requests that carried them couldn'), 'the next request holds the mended note');

      assert.deepEqual(r.framework.showSweep(NAME).changes, [], 'a second show lists nothing');
      const again = await r.framework.takeSweep(NAME);
      assert.equal(again.outcome, 'finished');
      assert.equal(again.took, null, 'a second write takes nothing');
    } finally { await r.close(); }
  });
});
