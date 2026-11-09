- A turn whose compile selects none of the conversation the agent's window
  holds, injections aside, ends before anything is sent. Its
  `[inference-failed]` notice says the turn wasn't sent, names the newest
  message by its author and channel from its metadata, or as a tool result
  from its content's block types, never its text, and says what follows if
  that message is too large for the context. The
  `context-refusal` ops alert, raised at once, gives the operator the
  budget's figures and what to change. It was sent anyway: in
  native mode the provider refused an empty message list with a 400
  `invalid_request`, which the poison-history breaker read as a bad history,
  so from the third failure in a row it set aside the newest turns, up to its
  cap of three, while every compile stayed empty. In XML tool mode, and
  wherever the framework added a row of its own such as a silent heartbeat
  tick's separator, the model took a turn with none of the conversation in
  view. The failure is classified `empty_compile`: `DefaultErrorPolicy`
  doesn't retry it, and the breaker never sheds on it. A turn whose window
  holds none of the conversation, as with an empty store or a resident with
  no row of its own in a shared slot, is sent as before.
