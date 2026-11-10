- A batched wake's message still the newest row of an agent's window that a
  reply could be meant for gets no `[Gate: …]` line, however many clock rows
  or stored context injections follow it. 0.27.0 said so of clock rows ("A
  clock row stored after the message doesn't count against it."), but 0.27.0
  through 0.34.0 read back only 32 such rows, and past them wrote the line
  though the message was still the newest.
