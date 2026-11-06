import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ContentBlock, NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import type { FrameworkConfig } from '../src/types/framework.js';
import { createMockResponse, type MockMembrane } from './helpers/mock-membrane.js';
import { fixture, eventually, settles } from './helpers/coalescing-fixture.js';
import { SUB, enter, internals, registerOpen } from './helpers/admission.js';

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: unknown;
};
type Row = { id: string; participant: string; content: Block[]; metadata?: Record<string, unknown> };
type Trace = { type: string; source?: string; kind?: string; agentName?: string; data?: { count?: number } };
type HeldWrite = { participant: string; content: Block[]; metadata?: Record<string, unknown> };
type Hidden = {
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  commitDeliveries(): boolean;
  surgeryHold: unknown;
  surgeryHeldWrites: HeldWrite[];
  pendingRequests: Array<{ agentName: string; reason: string; source?: string; timestamp?: number }>;
  streamCarried: WeakMap<YieldingStream, Set<string>>;
};
type Manager = {
  setStrategy(...args: unknown[]): Promise<unknown>;
  addMessage(...args: unknown[]): string;
};
const reader = 'Subconscious';
const channel = 'noisy';
const server = 'editor';
const contentText = (blocks: Block[]): string => blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const rowsOf = (f: Awaited<ReturnType<typeof fixture>>, name: string): Row[] =>
  f.framework.getAgent(name)!.getContextManager().getAllMessages() as unknown as Row[];
const windowOf = (f: Awaited<ReturnType<typeof fixture>>, name: string): Row[] =>
  f.framework.getAgent(name)!.getContextManager().getPresentedMessages() as unknown as Row[];
const literal = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value);

for (const loseReplay of [false, true]) {
  test(loseReplay
    ? 'persistent reader: a no-stop definite held-note replay refusal tells the reader its accepted note fate'
    : 'persistent reader control: a held note replay delivers the accepted note before any stop', { timeout: 120_000 }, async (t) => {
    const realNow = Date.now;
    let simulatedNow = Math.floor(realNow() / 1000) * 1000 + 100;
    Date.now = () => simulatedNow;
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    let gateOpen = (): void => {};
    let switching: Promise<void> | undefined;
    let removeTrace = (): void => {};
    let restoreCM = (): void => {};
    let restoreFramework = (): void => {};
    let restoreCoordinator = (): void => {};
    let restoreWake = (): void => {};
    let restoreStream = (): void => {};
    try {
      f = await fixture({
        framework: { subconscious: SUB, timeZone: 'UTC' } as Partial<FrameworkConfig>,
        agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', clock: { intervalSeconds: 1 } }],
        server: { shouldTriggerInference: () => false },
      });
      const first = f.framework;
      const hidden = first as unknown as Hidden;
      const sub = first.getAgent(reader);
      assert.ok(sub, 'setup: the persistent reader is configured');
      await registerOpen(f, channel);
      enter(f, channel, { backlogCap: 10, durationSeconds: 3600 });
      const coordinator = internals(f).tuneOutCoordinator!;
      const epoch = internals(f).channelRegistry.getTuneOutState(server, channel)?.params.epochId;
      assert.ok(epoch, 'setup: old tune-out epoch E is registered');
      const unique = randomUUID();
      const note = 'Fate note ' + unique + ' for epoch ' + epoch;
      const primer = 'Reader primer ' + unique;
      const callId = 'note-ask-' + unique;
      const faultTag = 'EIO: held note replay rejected ' + unique;
      const lossTurnReason = 'tune-out note not delivered: ' + channel;
      hidden.addMessage('user', [{ type: 'text', text: primer }], { system: true }, { forAgent: reader });
      hidden.addMessage('user', [{ type: 'text', text: 'Resident clock seed ' + unique }], { system: true });
      assert.ok(rowsOf(f, 'agent').some((row) => row.metadata?.kind === 'clock'), 'setup: resident has a baseline clock row');

      const hooks = (coordinator as unknown as {
        hooks: { writesHeld?: () => boolean; requestInference(name: string, reason: string, source: string): void };
        runDeferredCancels(): void;
      }).hooks;
      const writesHeld = hooks.writesHeld;
      hooks.writesHeld = () => true;
      restoreCoordinator = () => { hooks.writesHeld = writesHeld; };
      const membrane = f.membrane as MockMembrane;
      const mockCursor = membrane as unknown as { responseIndex: number };
      membrane.responses.length = 0;
      mockCursor.responseIndex = 0;
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: callId, name: 'cancel_tuneout', input: { channelId: channel, text: note } },
      ] as never, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }] as never));
      (internals(f) as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: reader, reason: 'test accepted note', source: 'test', timestamp: Date.now(),
      });
      try {
        await settles(first.runUntilIdle(), 'the persistent reader tool turn');
      } catch (error) {
        try {
          const state = first as unknown as {
            queue: { isEmpty: boolean };
            pendingRequests: Array<{ agentName: string; source?: string; reason: string }>;
            activeStreams: Map<string, unknown>;
            hasTurn(name: string): boolean;
          };
          t.diagnostic('initial-turn idle snapshot: ' + JSON.stringify({
            queueEmpty: state.queue.isEmpty,
            pending: state.pendingRequests.map(({ agentName, source, reason }) => ({ agentName, source, reason })),
            activeStreams: [...state.activeStreams.keys()],
            agents: ['agent', reader].map((name) => ({
              name, status: first.getAgent(name)?.state.status, hasTurn: state.hasTurn(name),
            })),
            mockCalls: (f.membrane as unknown as { calls: unknown[] }).calls.length,
            mockResponses: membrane.responses.length,
            mockConsumed: mockCursor.responseIndex,
            lastStreamToolBatches: membrane.lastStream?.receivedToolResults.length,
          }));
        } catch (snapshotError) {
          try { t.diagnostic('initial-turn snapshot unavailable: ' + String(snapshotError)); } catch {}
        }
        throw error;
      }
      const own = windowOf(f, reader);
      assert.ok(own.every((row) => row.id), 'setup: presented reader rows carry stable store identities');
      const priorReaderIds = new Set(own.map((row) => row.id));
      const uses = own.flatMap((row) => row.content.filter((block) => block.type === 'tool_use' && block.id === callId));
      const results = own.flatMap((row) => row.content.filter((block) => block.type === 'tool_result' && block.toolUseId === callId));
      assert.equal(uses.length, 1, 'setup: one reader-owned tool use for the unique note');
      assert.equal(uses[0]?.name, 'cancel_tuneout');
      assert.equal(uses[0]?.input?.text, note);
      assert.equal(results.length, 1, 'setup: ID-matched result reached the persistent reader window');
      assert.match(literal(results[0]?.content), /"waiting":true/, 'setup: the actual tool result says the note was accepted as waiting');
      const wire = membrane.lastStream?.receivedToolResults.flat() as Array<{ toolUseId?: string; content?: unknown }> | undefined;
      assert.ok(wire?.some((block) => block.toolUseId === callId && literal(block.content) === literal(results[0]?.content)),
        'setup: the ID-matched waiting answer was supplied to the reader model stream');
      assert.ok(own.some((row) => contentText(row.content).includes(primer)), 'setup: same reader has its primer');
      assert.equal(internals(f).channelRegistry.getTuneOutState(server, channel)?.params.epochId, epoch);
      const deferredForEpoch = () => [...(coordinator as unknown as {
        deferredCancels: Map<string, {
          for: { epochId: string; serverId: string; channelId: string };
          note?: string; noteAuthor?: string; askers: string[]; noteSettled?: true; heldInMemory?: true;
        }>;
      }).deferredCancels.values()].filter((entry) =>
        entry.for.epochId === epoch && entry.for.serverId === server && entry.for.channelId === channel);
      const queued = deferredForEpoch();
      assert.equal(queued.length, 1, 'setup: one queued cancel matches the original hold epoch and channel');
      assert.equal(queued[0]?.note, note, 'setup: the original tool call placed its unique note on that cancel');
      assert.equal(queued[0]?.noteAuthor, reader, 'setup: the living reader authored this queued note');
      assert.deepEqual(queued[0]?.askers, [reader], 'setup: no other asker can supply this note or loss');
      assert.equal(queued[0]?.noteSettled, undefined, 'setup: the note has not been resolved yet');
      assert.equal(internals(f).pendingRequests.filter((request) =>
        request.agentName === reader && request.reason === lossTurnReason).length, 0,
      'setup: no loss turn for this note exists before the targeted replay');
      first.getStore().sync();
      restoreCoordinator();
      restoreCoordinator = () => {};
      const primaryManager = first.getAgent('agent')!.getContextManager() as unknown as Manager;
      const setStrategy = primaryManager.setStrategy;
      const addToManager = primaryManager.addMessage;
      const managerGate = new Promise<void>((resolve) => { gateOpen = resolve; });
      let managerEntered = 0;
      primaryManager.setStrategy = async (...args) => {
        managerEntered++;
        await managerGate;
        return setStrategy.apply(primaryManager, args);
      };
      restoreCM = () => {
        primaryManager.setStrategy = setStrategy;
        primaryManager.addMessage = addToManager;
      };

      const addToFramework = hidden.addMessage;
      const noteIds: string[] = [];
      let noteCalls = 0;
      hidden.addMessage = (participant, blocks, metadata, opts) => {
        const thisNote = metadata?.kind === 'subconscious-note'
          && metadata.epochId === epoch
          && blocks.some((block) => block.type === 'text' && block.text === note);
        if (thisNote) noteCalls++;
        const id = addToFramework.call(hidden, participant, blocks, metadata, opts);
        if (thisNote) noteIds.push(id);
        return id;
      };
      const commit = hidden.commitDeliveries;
      let advanced = false;
      hidden.commitDeliveries = () => {
        const durable = commit.call(hidden);
        if (durable && !advanced && rowsOf(f!, 'agent').some((row) =>
          row.metadata?.kind === 'tune-out-cancel' && row.metadata.epochId === epoch)) {
          simulatedNow += 2_000;
          advanced = true;
        }
        return durable;
      };
      restoreFramework = () => {
        hidden.addMessage = addToFramework;
        hidden.commitDeliveries = commit;
      };

      const traces: Trace[] = [];
      let watchEnd = false;
      const readerStarts: Trace[] = [];
      const prematureReaderStarts: Trace[] = [];
      const readerCompletions: Trace[] = [];
      removeTrace = first.onTrace((event) => {
        const trace = event as Trace;
        traces.push(trace);
        if (watchEnd && trace.type === 'inference:started' && trace.agentName === reader) {
          readerStarts.push(trace);
          if (hidden.surgeryHold !== null || internals(f!).channelRegistry.getTuneOutState(server, channel) !== null) {
            prematureReaderStarts.push(trace);
          }
        }
        if (watchEnd && trace.type === 'inference:completed' && trace.agentName === reader) readerCompletions.push(trace);
        if (trace.type === 'message:added' && trace.source === 'clock:event' && !switching) {
          switching = first.switchBranch(first.getStore().currentBranch().name);
          void switching.catch(() => {});
        }
      });
      coordinator.runDeferredCancels();
      assert.ok(advanced, 'setup: the old release synced before the note clock became due');
      assert.ok(switching, 'setup: the due clock trace started a real same-branch switch');
      assert.ok(hidden.surgeryHold, 'setup: the operator switch reserved the store');
      const heldNotes = hidden.surgeryHeldWrites.filter((write) =>
        write.metadata?.kind === 'subconscious-note' && write.metadata.epochId === epoch
        && contentText(write.content) === note);
      assert.equal(heldNotes.length, 1, 'setup: exactly the original note is held for replay');
      assert.deepEqual(noteIds, [''], 'setup: the note write returned an empty ID while held');
      assert.equal(noteCalls, 1);
      const originalNoteRows = () => rowsOf(f!, 'agent').filter((row) =>
        row.metadata?.kind === 'subconscious-note' && row.metadata.epochId === epoch
        && contentText(row.content) === note);
      assert.equal(originalNoteRows().length, 0, 'setup: the note is absent from the resident store while held');
      assert.ok(rowsOf(f, 'agent').some((row) =>
        row.metadata?.kind === 'tune-out-cancel' && row.metadata.epochId === epoch),
      'setup: the release row was written for the original hold');
      assert.equal(internals(f).channelRegistry.getTuneOutState(server, channel)?.params.epochId, epoch,
        'setup: the current-head hold remains in force while the note is held');
      const requeued = deferredForEpoch();
      assert.equal(requeued.length, 1, 'setup: the same old cancel was requeued while the surgery holds its note');
      assert.equal(requeued[0], queued[0], 'setup: requeued entry is the accepted reader-owned cancel, not a substitute');
      assert.equal(requeued[0]?.note, note);
      assert.equal(requeued[0]?.noteAuthor, reader);
      assert.equal(requeued[0]?.noteSettled, true, 'setup: the coordinator marked the held note settled');
      assert.equal(requeued[0]?.heldInMemory, true, 'setup: the coordinator knows this note write remains in memory');
      await eventually(() => managerEntered > 0, 'the actual branch switch reinitialization paused');

      let faultAttempts = 0;
      if (loseReplay) {
        primaryManager.addMessage = (...args) => {
          const [participant, blocks, metadata] = args as [string, ContentBlock[], Record<string, unknown> | undefined];
          if (participant === reader && metadata?.kind === 'subconscious-note'
            && metadata.epochId === epoch
            && blocks.some((block) => block.type === 'text' && block.text === note)) {
            faultAttempts++;
            throw new Error(faultTag);
          }
          return addToManager.apply(primaryManager, args);
        };
      }
      const hostWakes: Array<{ name: string; reason: string; source: string; queued: boolean }> = [];
      const requestInference = hooks.requestInference;
      hooks.requestInference = (name, reason, source) => {
        requestInference.call(hooks, name, reason, source);
        if (name === reader) hostWakes.push({
          name, reason, source,
          queued: hidden.pendingRequests.some((request) =>
            request.agentName === name && request.reason === reason && request.source === source),
        });
      };
      restoreWake = () => { hooks.requestInference = requestInference; };
      const streams: Array<{
        request: NormalizedRequest; stream: YieldingStream; completeQueuedAtCreate: boolean; endedAtCreate: boolean;
      }> = [];
      const streamYielding = membrane.streamYielding;
      membrane.streamYielding = (request, options) => {
        const responses = membrane.responses;
        const index = mockCursor.responseIndex;
        membrane.responses = [request.assistantParticipant === reader
          ? createMockResponse([{ type: 'text', text: '>>skip_reply' }])
          : createMockResponse([])];
        mockCursor.responseIndex = 0;
        try {
          const stream = streamYielding.call(membrane, request, options);
          const events = (stream as unknown as { events: Array<{ type: string }> }).events;
          streams.push({
            request, stream,
            completeQueuedAtCreate: events.some((event) => event.type === 'complete'),
            endedAtCreate: hidden.surgeryHold === null
              && internals(f!).channelRegistry.getTuneOutState(server, channel) === null,
          });
          return stream;
        } finally {
          membrane.responses = responses;
          mockCursor.responseIndex = index;
        }
      };
      restoreStream = () => { membrane.streamYielding = streamYielding; };
      watchEnd = true;
      gateOpen();
      await settles(switching, 'the real same-branch switch, held-note replay and deferred cancel');
      assert.equal(f.framework, first, 'setup: the original host and reader remain alive through replay');
      assert.equal(first.getAgent(reader), sub, 'setup: the original persistent reader still serves');
      assert.equal(hidden.surgeryHold, null, 'setup: the operator hold released before recipient inspection');
      assert.equal(hidden.surgeryHeldWrites.length, 0, 'setup: no held note remains pending in memory');
      assert.equal(deferredForEpoch().length, 0, 'setup: the original deferred cancel ran after replay');
      assert.equal(internals(f).channelRegistry.getTuneOutState(server, channel), null,
        'setup: the original hold ended after the note replay without a stop');
      assert.equal(internals(f).channelRegistry.getDesiredState(server, channel), 'open',
        'setup: the channel is still registered while this reader lives');
      assert.equal(faultAttempts, loseReplay ? 1 : 0, 'setup: only the targeted held note met the replay fault');
      if (loseReplay) {
        assert.equal(originalNoteRows().length, 0, 'the definitely refused note did not land');
        assert.equal(traces.filter((trace) => trace.type === 'message:lost'
          && trace.source === 'surgery-release' && trace.agentName === 'agent').length, 1,
        'one definite held write was reported lost by the Framework');
        assert.equal(traces.filter((trace) => trace.type === 'ops:alert'
          && trace.kind === 'store-held-lost' && trace.agentName === 'agent'
          && trace.data?.count === 1).length, 1,
        'the isolated held write was reported to the operator, not counted as a reader notice');
      } else {
        assert.equal(originalNoteRows().length, 1, 'control: exactly one original note reached the resident store');
      }
      restoreCM();
      restoreCM = () => {};
      restoreFramework();
      restoreFramework = () => {};
      first.getStore().sync();
      const marker = 'Writable live host ' + unique;
      hidden.addMessage('user', [{ type: 'text', text: marker }], { system: true });
      first.getStore().sync();
      assert.ok(rowsOf(f, 'agent').some((row) => contentText(row.content) === marker),
        'setup: the still-running host accepts and syncs a new write after replay');
      assert.equal(internals(f).channelRegistry.getTuneOutState(server, channel), null,
        'setup: the original epoch remains ended on this live host');
      const readerWindow = windowOf(f, reader);
      assert.ok(readerWindow.some((row) => contentText(row.content).includes(primer)),
        'setup: the original persistent reader still has its primer before any stop');
      assert.equal(readerWindow.flatMap((row) => row.content.filter((block) =>
        block.type === 'tool_use' && block.id === callId && block.input?.text === note)).length, 1,
      'setup: the living reader still has its own unique accepted call');
      assert.equal(readerWindow.flatMap((row) => row.content.filter((block) =>
        block.type === 'tool_result' && block.toolUseId === callId
        && /"waiting":true/.test(literal(block.content)))).length, 1,
      'setup: the living reader still has its original waiting answer without a restart');
      const residentNote = rowsOf(f, 'agent').filter((row) => row.metadata?.kind === 'subconscious-note'
        && row.metadata.epochId === epoch && contentText(row.content) === note);
      assert.equal(residentNote.length, loseReplay ? 0 : 1,
        'the original note landed for the resident on success, or not after definite loss');
      const preNeutralRequests = hidden.pendingRequests.filter((request) => request.agentName === reader);
      const hostLossWakes = hostWakes.filter((wake) =>
        wake.name === reader && wake.reason === lossTurnReason && wake.source === 'tune-out');
      const hostLossQueued = hostLossWakes.filter((wake) => wake.queued);
      const preNeutralStreams = streams.filter(({ request }) => request.assistantParticipant === reader);
      const hostReaderStartsBeforeStimulus = readerStarts.length;
      const hostFirst = hostReaderStartsBeforeStimulus > 0 || preNeutralStreams.length > 0 || preNeutralRequests.length > 0
        || hostWakes.some((wake) => wake.queued);
      if (!hostFirst) {
        hidden.pendingRequests.push({
          agentName: reader, reason: 'neutral post-end reader check', source: 'test', timestamp: Date.now(),
        });
      }
      try {
        await settles(first.runUntilIdle(), hostFirst
          ? 'the host-origin same-reader model request' : 'the neutral same-reader model request');
      } catch (error) {
        t.diagnostic(JSON.stringify({
          readerTurnFailed: String(error), trigger: hostFirst ? 'host' : 'neutral',
          hostWakes, preNeutralRequests, readerStarts: readerStarts.length,
          capturedParticipants: streams.map(({ request }) => request.assistantParticipant),
        }));
        throw error;
      }
      assert.equal(first.getAgent(reader), sub, 'setup: the scored request used the original persistent reader');
      const readerStreams = streams.filter(({ request }) => request.assistantParticipant === reader);
      assert.equal(readerStarts.length, 1, 'setup: exactly one reader turn began after the hold end');
      assert.equal(readerStreams.length, 1, 'setup: exactly one reader mock-model request was captured');
      assert.equal(prematureReaderStarts.length, 0, 'setup: the scored reader turn began after the hold ended');
      const captured = readerStreams[0]!;
      assert.equal(captured.endedAtCreate, true, 'setup: the scored reader request was compiled after the hold ended');
      const scoredEvents = (captured.stream as unknown as { events: Array<{ type: string }> }).events;
      assert.equal(captured.completeQueuedAtCreate, true,
        'setup: the scored mock stream initially queued its own complete event');
      assert.equal(scoredEvents.some((event) => event.type === 'complete'), false,
        'setup: the scored stream consumed its own terminal complete event');
      assert.equal(readerCompletions.length, 1,
        'setup: the one scored reader stream has one completed inference trace');
      const carried = hidden.streamCarried.get(captured.stream);
      assert.ok(carried, 'setup: the actual reader model stream has compile row provenance');
      const textBlocks = (captured.request.messages as unknown as Array<{ content: Block[] }>)
        .flatMap((message) => message.content)
        .filter((block): block is Block & { text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
      const newNoteId = residentNote[0]?.id;
      const noteCarried = newNoteId !== undefined && carried.has(newNoteId);
      const noteText = textBlocks.some((text) => text.includes(note));
      const nextWindow = windowOf(f, reader);
      const fateCandidates = nextWindow.filter((row) =>
        !priorReaderIds.has(row.id) && row.participant === 'user'
        && row.metadata?.system === true && row.metadata.epochId === epoch
        && row.metadata.channelId === channel
        && (row.metadata.kind === 'tune-out-note-undelivered'
          || (row.metadata.kind === 'tune-out-cancel' && row.metadata.lostNote === true)));
      const readerFate = fateCandidates.filter((row) => {
        const words = contentText(row.content);
        const claim = 'was not delivered to agent.';
        const at = words.indexOf(claim);
        if (at < 0 || !words.includes(channel) || !/[A-Za-z]/.test(words.slice(at + claim.length))) return false;
        if (row.metadata?.kind === 'tune-out-note-undelivered') {
          return words.includes('the note you left with your cancel of');
        }
        return words.includes('note Subconscious left with an earlier cancel of');
      });
      const fateInRequest = readerFate.filter((row) =>
        carried.has(row.id) && textBlocks.some((text) => text.includes(contentText(row.content))));
      t.diagnostic(JSON.stringify({
        loseReplay, epoch, clockAdvanced: advanced, heldNotes: heldNotes.length,
        noteCalls, noteIds, faultAttempts, residentNote: residentNote.length,
        readerWindowNote: nextWindow.filter((row) => row.metadata?.kind === 'subconscious-note'
          && row.metadata.epochId === epoch && contentText(row.content) === note).length,
        readerRequest: captured.request.assistantParticipant,
        requestOrigin: hostFirst ? 'host' : 'neutral',
        hostReaderStartsBeforeStimulus, preNeutralRequests, prematureReaderStarts: prematureReaderStarts.length,
        terminalQueuedAtCreate: captured.completeQueuedAtCreate,
        terminalQueuedAfterRun: scoredEvents.some((event) => event.type === 'complete'),
        readerCompletions: readerCompletions.length,
        noteCarried, noteText, newNoteId, carriedBodies: [...carried],
        hostLossWakes, hostLossQueued: hostLossQueued.length,
        fateCandidates: fateCandidates.map((row) => ({ id: row.id, kind: row.metadata?.kind, text: contentText(row.content) })),
        readerFate: readerFate.map((row) => contentText(row.content)),
        fateInRequest: fateInRequest.map((row) => row.id),
      }));
      assert.ok(!noteText || noteCarried,
        'setup: note text without the new note row has ambiguous provenance, not delivery');
      assert.equal(noteCarried && noteText, !loseReplay,
        loseReplay ? 'the definitely lost note is absent from the reader model request'
          : 'the same living reader model request contains the newly delivered note');
      assert.equal(fateInRequest.length, loseReplay ? 1 : 0,
        loseReplay ? 'the next reader model request contains the specific loss notice'
          : 'control: no false loss notice entered the reader model request');
      assert.equal(hostLossQueued.length, loseReplay ? 1 : 0,
        loseReplay ? 'the host itself queued a turn to read the definite loss'
          : 'control: no false host-owed loss turn');
    } finally {
      gateOpen();
      if (switching) {
        try { await settles(switching, 'the switch during fixture cleanup'); } catch {}
      }
      removeTrace();
      restoreCM();
      restoreFramework();
      restoreCoordinator();
      restoreWake();
      restoreStream();
      Date.now = realNow;
      if (f) await f.close();
    }
  });
}
