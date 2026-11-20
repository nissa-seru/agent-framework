- The framework has a sweep of its own, `unstick-fix-11-16`. It takes the
  provider's words out of the rewind and failed-turn notes that
  agent-framework 0.33.1 and earlier stored in an agent's context: a
  refusal's category in a rewind note, and the provider's message after
  "Reason:" in a failed-turn note. A rewind note keeps its tag and its count.
  A failed-turn note keeps its cause, unless the cause is `safety`, and its
  advice. `listSweeps()` lists it beside a host's entries, and `create()`
  refuses a host's entry with its name. Call `showSweep('unstick-fix-11-16')`
  first to see what it would rewrite and which agents read it, then
  `takeSweep('unstick-fix-11-16')` once in each store. It leaves the notes
  that agent-framework 0.33.2 and later write, but for one case: a
  failed-turn note's reason that a later release writes itself, of a kind
  that 0.33.3 doesn't write. The sweep knows its own reasons from a copy of
  0.33.3's: a compile that context-manager refused, a stream's abort, and a
  progress bound's cut. It leaves a note with such a reason, whichever
  release wrote it. It leaves a body that the framework didn't write as a
  note, such as a message that quotes one. A summary that a strategy wrote
  from an old note keeps what it says: the sweep rewrites the note, not the
  summary.
