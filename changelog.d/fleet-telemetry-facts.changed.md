- `message:added` for a prose bounce's notice or a script's wake that was
  deferred at arrival has `messageId: ''` and its `deferredId`, as every
  other deferred write's has, where it was `'deferred'`. The gate's own
  writes (a self-wake's notice, a debounce batch's `[Gate: …]` line), the
  tune-out coordinator's writes (its `source` the row's `kind`) and an idle
  conversation's closure prompt are traced as `message:added`, which they
  weren't, and a deferred write's flush at a turn's start or an assembly
  names its agent and deferred id.
- On the channel, wake-rule, workspace and `agent_settings` tool paths, `tool:failed`
  for a result marked an error with no error text says `tool returned an
  error`, as the MCP path already did, where these paths sent no `error`;
  and on these four and the MCP path, such a result whose error text is
  empty says so too, one a throw with an empty message became included. A
  throw the path traces itself, on the channel and MCP dispatches, is
  traced with its error's message, as before.
  A modern MCP server's close sends `mcpl:server-closed` with
  `reason: null`, as the union's entry requires.
- A consumer that switches over `TraceEvent['type']` exhaustively sees the
  types the union now declares (above): they were emitted before, outside
  the union. So does one that keeps an entry for each trace type: the 25
  the components emitted, and the 3 this change adds (`inference:request`,
  `message:addressed`, `message:withdrawn`). `TRACE_EVENT_TYPES` lists
  them all.
