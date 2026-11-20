- Sweeps (context-manager's `SweepEntry`): a host gives its entries in
  `FrameworkConfig.sweeps`, and `create()` refuses two entries with one name.
  `showSweep(name)` says what a sweep would change on the store's branch,
  once per body, with the agents whose window holds it and each agent's
  count of old summaries, and writes nothing. `takeSweep(name)` takes the
  sweep and applies it under the store's reservation, as a branch switch
  does: it ends `finished`, `failed` with the bodies that were not
  rewritten, or `held` where an agent's turn is alive, and the next start
  applies it then. `sweepReceipt(name)` says where it stands.
  `oldSummaryCost(agent, name)` and `dropOldSummaries(agent, name)` are the
  second act: one agent's strategy drops its old summaries over the
  rewritten rows, under the same reservation. The framework also applies an
  owed sweep at its start, after each branch move, and as an agent whose
  context already held rows is taken on for a run. The removed shards of a
  long note leave every window (`presentation:retracted`, reason `sweep`),
  the history module's semantic index sends a rewritten body again and drops
  a removed shard, also for a pass made while it was not attached, and each
  pass is traced (`sweep:pass`, `sweep:pass-failed`). The operator log
  records a take as `sweep` and the second act as `sweep-summaries`.
