import type { MessageMetadata, SweepBody, SweepEntry } from '@animalabs/context-manager';

const SET_ASIDE = 'because the requests that carried them couldn\'t be completed';
const REWIND_REST = `were set aside ${SET_ASIDE}. Their content isn't shown here, and the originals remain in the raw ` +
  'record. You are clear to continue — if you were mid-task, take a different approach; otherwise carry on with ' +
  'whatever is now in front of you, or briefly acknowledge the gap and ask what\'s next.';
const FAILURE_ADVICE = 'If this recurs with the same cause, change approach rather than retrying identically ' +
  '(e.g. drop an oversized attachment or an unsupported setting).';
const TIMEOUT_ADVICE = 'If a reply is still owed from that turn, you can give it now.';
const REWIND_OPENING = /^\[[^\]]+\] (?:The \d+ most recent turn\(s\)|Some recent turns) were set aside /;
const OLD_REWIND_OPENING = /^\[refusal-rewind\] (?:The (\d+) most recent turn\(s\)|Turns|Some recent turns) were set aside because /;
const FAILED_OPENING = '[inference-failed] Your previous turn did not complete: ';
const REASON = '. Reason: ';
const SAFETY_CAUSE = /(failed|timed out) \(safety(?:, HTTP \d+)?\)/;
const COMPILE_REFUSALS = new Set(['over_budget', 'context_refusal']);
const BOUND_CUT = /^(?:No content within |No provider event within |No provider progress within |The provider made no progress within the call's bound)/;

function reasonOfItsOwn(metadata: MessageMetadata): boolean {
  const { reason, errorType, retryable } = metadata;
  if (typeof reason !== 'string') return false;
  if (typeof errorType === 'string' && COMPILE_REFUSALS.has(errorType)) return true;
  if (errorType === undefined) return reason.startsWith('Stream aborted: ');
  if (errorType !== 'timeout') return false;
  return BOUND_CUT.test(reason) || retryable === false;
}

function noteText(body: SweepBody): string | null {
  const [block, ...rest] = body.content;
  return block !== undefined && block.type === 'text' && rest.length === 0 ? block.text : null;
}

function mendedText(metadata: MessageMetadata, text: string): string | null {
  if (metadata.kind === 'refusal-rewind') {
    const current = REWIND_OPENING.exec(text);
    if (current !== null && text.startsWith(SET_ASIDE, current[0].length)) return null;
    const old = OLD_REWIND_OPENING.exec(text);
    if (old === null) return null;
    const told = old[1];
    const count = told === undefined ? 'Some recent turns' : `The ${told} most recent turn(s)`;
    return `[refusal-rewind] ${count} ${REWIND_REST}`;
  }
  if (metadata.kind === 'inference-failed') {
    if (!text.startsWith(FAILED_OPENING)) return null;
    const at = text.indexOf(REASON);
    if (at < 0 || reasonOfItsOwn(metadata)) return null;
    const head = text.slice(0, at + 1).replace(SAFETY_CAUSE, '$1');
    const advice = [FAILURE_ADVICE, TIMEOUT_ADVICE].find((each) => text.endsWith(each));
    return advice === undefined ? head : `${head} ${advice}`;
  }
  return null;
}

export const UNSTICK_FIX_11_16: SweepEntry = {
  name: 'unstick-fix-11-16',
  line: 'Takes the provider\'s words out of the rewind and failed-turn notes that agent-framework 0.33.1 and earlier ' +
    'wrote, and leaves a failed-turn note whose reason agent-framework 0.33.3 writes itself.',
  mend(body) {
    const { metadata } = body;
    if (metadata === undefined || metadata.system !== true) return null;
    const text = noteText(body);
    if (text === null) return null;
    const mended = mendedText(metadata, text);
    return mended === null ? null : [{ type: 'text', text: mended }];
  },
};
