/** The newest row of the conversation in an agent's view, named from its metadata, its content's block types and its own-row stamp, never its text. */
export interface NewestRow {
  /** Its author, where its metadata names one. */
  sender?: string;
  /** Its channel, where its metadata names one. */
  channel?: string;
  /** Whether it is a tool result. */
  toolResult?: boolean;
  /** Whether the agent wrote it, and whether it is a tool call. */
  own?: 'tool-call' | 'message';
}

/**
 * Thrown before a request is sent when its compile selected none of the
 * conversation the agent's window holds. Sent, such a request is refused by
 * the provider, or answered with a turn that sees none of the conversation:
 * an injection, a silent heartbeat tick's separator or tool results appended
 * to it don't change that. Not retryable: the same store compiles to the same
 * nothing. Its message is the reason the agent's `[inference-failed]` notice
 * gives: that none of the conversation reached the context, without saying
 * why, the newest row, and what follows if that row is too large, without
 * claiming that it is. `operatorNote` gives the operator the strategy that
 * selected nothing, the budget's figures and what to change.
 */
export class EmptyCompileError extends Error {
  readonly retryable = false;
  readonly operatorNote: string;

  constructor(budgetTokens: number, reserveTokens: number, newest: NewestRow = {}, strategy?: string) {
    const usable = budgetTokens - reserveTokens;
    const named = newestNamed(newest, 'your');
    const that = named ? 'that message' : 'the newest message in your conversation';
    const remedy = newest.own !== undefined ? ''
      : `, and you can ${newest.toolResult ? 'call for less of it' : 'ask for it in smaller parts'}`;
    super(
      usable <= 0
        ? 'the context budget leaves no room for any of your conversation once the reply\'s share is set aside, ' +
          'and only an operator can raise the budget'
        : `none of your conversation reached your context.${named ? ` ${named}.` : ''} ` +
          `If ${that} is too large for your context, it and everything before it stay out of what you see ` +
          `until an operator raises your budget${remedy}`,
    );
    this.name = 'EmptyCompileError';
    const operatorNamed = newestNamed(newest, 'its');
    this.operatorNote = usable <= 0
      ? `contextBudgetTokens (${budgetTokens}) leaves no room once ${reserveTokens} tokens are reserved for the reply: raise contextBudgetTokens.`
      : `${strategy ? `the ${strategy} strategy` : 'the compile'} selected none of the agent's conversation; ` +
        `${usable} of a ${budgetTokens}-token budget is usable after ${reserveTokens} reserved for the reply. ` +
        `If the newest message in its conversation is larger than ${usable} tokens, ` +
        'it and everything before it stay out of every compile until the budget can hold it: raise contextBudgetTokens.' +
        `${operatorNamed ? ` ${operatorNamed}.` : ''}`;
  }
}

/** The sentence naming the newest row, for the agent (`your`) or the operator (`its`), or undefined where nothing names it. */
function newestNamed(newest: NewestRow, whose: 'your' | 'its'): string | undefined {
  const lead = `The newest message in ${whose} conversation`;
  if (newest.toolResult) return `${lead} is a tool result`;
  if (newest.own === 'tool-call') return `${lead} is ${whose} own tool call`;
  if (newest.own === 'message') return `${lead} is one ${whose === 'your' ? 'you' : 'it'} wrote`;
  if (newest.sender !== undefined && newest.channel !== undefined) return `${lead} is from ${newest.sender} in ${newest.channel}`;
  if (newest.sender !== undefined) return `${lead} is from ${newest.sender}`;
  if (newest.channel !== undefined) return `${lead} is in ${newest.channel}`;
  return undefined;
}
