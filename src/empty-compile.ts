/** The newest row of the conversation in an agent's view, named from its metadata alone, never its content. */
export interface NewestRow {
  /** Its author, where its metadata names one. */
  sender?: string;
  /** Its channel, where its metadata names one. */
  channel?: string;
  /** Whether it is a tool result. */
  toolResult?: boolean;
}

/**
 * Thrown before a request is sent when its compile selected none of the
 * conversation the agent's window holds. Sent, such a request is refused by
 * the provider, or answered with a turn that sees none of the conversation:
 * an injection, a silent heartbeat tick's separator or tool results appended
 * to it don't change that. Not retryable: the same store compiles to the same
 * nothing. Its message is the reason the agent's `[inference-failed]` notice
 * gives: it names the newest row and what follows if that row is too large,
 * without claiming that it is. `operatorNote` gives the operator the
 * budget's figures and what to change.
 */
export class EmptyCompileError extends Error {
  readonly retryable = false;
  readonly operatorNote: string;

  constructor(budgetTokens: number, reserveTokens: number, newest: NewestRow = {}) {
    const usable = budgetTokens - reserveTokens;
    const named = newestNamed(newest, 'your conversation');
    const that = named ? 'that message' : 'the newest message in your conversation';
    super(
      usable <= 0
        ? 'the context budget leaves no room for any of your conversation once the reply\'s share is set aside, ' +
          'and only an operator can raise the budget'
        : `none of your conversation fit in your context.${named ? ` ${named}.` : ''} ` +
          `If ${that} is too large for your context, it and everything before it stay out of what you see ` +
          `until an operator raises your budget, and you can ${newest.toolResult ? 'call for less of it' : 'ask for it in smaller parts'}`,
    );
    this.name = 'EmptyCompileError';
    this.operatorNote = usable <= 0
      ? `contextBudgetTokens (${budgetTokens}) leaves no room once ${reserveTokens} tokens are reserved for the reply: raise contextBudgetTokens`
      : `nothing in the agent's window fit the ${usable} tokens a ${budgetTokens}-token budget leaves after ${reserveTokens} reserved for the reply.` +
        `${named ? ` ${newestNamed(newest, 'it')}.` : ''} If ${named ? 'that message' : 'its newest message'} is larger than that, it and everything before it stay out of every compile ` +
        'until the budget can hold it: raise contextBudgetTokens';
  }
}

function newestNamed(newest: NewestRow, where: string): string | undefined {
  const lead = `The newest message in ${where}`;
  if (newest.toolResult) return `${lead} is a tool result`;
  if (newest.sender !== undefined && newest.channel !== undefined) return `${lead} is from ${newest.sender} in ${newest.channel}`;
  if (newest.sender !== undefined) return `${lead} is from ${newest.sender}`;
  if (newest.channel !== undefined) return `${lead} is in ${newest.channel}`;
  return undefined;
}
