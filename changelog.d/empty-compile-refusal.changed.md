- After a turn that failed because its context can't be fitted
  (`empty_compile` or `over_budget`), the next such failure writes no
  `[inference-failed]` notice while the newest row in the agent's window is
  still the last one's, so a run of them leaves one notice where each wrote
  its own. Other failures still write one each, and a turn that got partway
  always writes its own, which says how far it got.
