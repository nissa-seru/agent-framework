- `AgentFramework.addMessageFor(agentName, participant, content, metadata?)`
  writes a message into a named agent's window, for host code that leaves an
  agent a note. It's held and lands as the framework's own writes for that
  agent are: while the host is quiesced, behind what's already held, until
  `resume()`; while the agent's turn is alive, until that agent's next
  boundary; otherwise at once. An ordinary resident's window is the slot the
  residents share. It requests no turn. A name that isn't a registered
  agent throws, naming it and the registered agents, and so does content
  holding a `tool_use` or `tool_result` block.
