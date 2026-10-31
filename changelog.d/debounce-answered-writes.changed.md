- A batched wake's `[Gate: …]` line is written at the wake's turn start, not
  when the batch fires, whenever the batch has an event the agent may have
  answered by then, and it names only the events not yet answered then. A
  batch the agent answered leaves no line. As before, only the delivery
  agent's own start writes it, so when that agent has answered the batch, the
  residents who share its slot still wake, and find no line. The lines one
  start is handed are written as one `[Gate: N events matched]` line, each
  channel's messages counted together, where each was written on its own.
- The reply judge is told that a pending debounced batch with a written
  event, and a queued wake whose requests all name the messages they're for,
  only may wake the agent (`certain: false`), since each starts no turn once
  the agent has answered them.
