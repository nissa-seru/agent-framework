- A debounced gate batch's wake starts no turn for an agent that has already
  read and answered every event in it (#814). Each event is judged as a direct
  wake's message is: its message at or under a request the agent answered
  and, for one a reply is owed for (a registered channel's, not marked
  `chat:ambient` or `chat:system`), the agent's publication there since it
  read it; or its message gone. The scheduler judges it when the agent's turn
  would start, so after the agent's last turn and that turn's final
  publication have ended. A request that fails or is aborted answers
  nothing, though a round of the turn that came back before it has answered
  what that round read; an event the host gave no message of its own keeps
  the wake. This covers module events, MCPL channel messages and pushes,
  those routed to a conversation fork included, and heartbeat ticks and
  reminders; a reply judge's batches and a deferred render's batched wake are
  unchanged.
