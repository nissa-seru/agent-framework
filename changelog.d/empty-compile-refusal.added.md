- `EmptyCompileError`, exported: thrown before sending when a compile
  selects none of the conversation the agent's window holds, with
  `retryable: false`. Its message is the reason the agent is given, and its
  `operatorNote` gives the budget's figures and what to change; on the
  framework's own turns the `inference:exhausted` trace carries it to the
  `context-refusal` alert. A direct-API caller (`runInference`,
  `runInferenceWithInjections`) now gets it, with no request sent, where its
  request went out holding none of the conversation, which the provider
  refused with a 400 `invalid_request` in native mode when nothing else
  filled it.
