- `AgentFramework.addMessageFor(agentName, participant, content, metadata?)`
  writes a message into a named agent's window, for host code that leaves an
  agent a note. It's held and lands as the framework's own writes for that
  agent are: stored at once while the host isn't quiesced and the agent is
  idle; otherwise held, behind what's already held for it, until that
  agent's next boundary, or `resume()` while the host is quiesced (a turn
  still running out a quiesce's drain can hear it at a tool round first).
  An ordinary resident's window is the slot the residents share. It
  requests no turn. It throws, naming what it refuses, once `stop()` has
  begun, for a name that isn't a registered agent, and for content holding
  a `tool_use` or `tool_result` block.
