- The framework has a sweep of its own, `unstick-fix-11-16`. It takes the
  provider's words out of the rewind and failed-turn notes that
  agent-framework 0.33.1 and earlier stored in an agent's context: a
  refusal's category in a rewind note, and the provider's message after
  "Reason:" in a failed-turn note. A rewind note keeps its tag and its count.
  A failed-turn note keeps its cause, unless the cause is `safety`, and its
  advice. `listSweeps()` lists it before a host's entries, and `create()`
  refuses a host's entry with its name. Call `showSweep('unstick-fix-11-16')`
  first to see what it would rewrite and which agents read it. Then call
  `takeSweep('unstick-fix-11-16')` in each store, and read its outcome: one
  that ends `held` is applied at the next start or branch move, or by the
  same call between turns, and one that ends `failed` names each note it
  didn't rewrite. It leaves the notes that agent-framework 0.33.2 and later
  write, and a failed-turn note whose reason is of a kind that 0.33.3 writes
  itself, whichever release wrote it: a compile that context-manager
  refused, a stream's abort, and a progress bound's cut. It knows these by
  the type and reason stored with the note, from its own copy of 0.33.3's
  shapes. So a provider's message that a release before 0.33.2 stored with
  such a type and opening is left too, and a reason of a new kind that a
  later release writes itself would be cut. It leaves a body that the
  framework didn't write as a note, such as a message that quotes one. A
  summary that a strategy wrote from an old note keeps what it says: the
  sweep rewrites the note, not the summary.
