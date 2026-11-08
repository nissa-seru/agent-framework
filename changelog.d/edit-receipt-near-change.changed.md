- **Agents and hosts:** an `edit` or `edit_many` answer shows less of the
  lines around a change. 0.24.0 gave its region as "the changed region with
  two lines on each side, numbered as `read` numbers lines, a line over 2,000
  characters from at most 80 characters before the change on it", so in a
  file of paragraph-long lines each of those lines showed whole, up to 2,000
  characters. The region keeps its lines and their numbers, and now shows of
  them only what's near the change: the new text with up to 80 characters on
  each side of it, as far as a line's 2,000 allows, and of each line before
  and after, its 80 characters nearest the change. What it leaves out of a
  line is marked with how many characters it holds, as a long line's
  left-out parts were, and a part is left out only where its marker is
  shorter than it, so a line with nothing worth cutting reads as before
  (connectome-host#546). Both tools' descriptions change with it. Where
  `edit`'s said the answer shows "a long line from shortly before the change
  on it, as its length allows", it says the answer shows the changed region
  "as the part of each line nearest the change"; where `edit_many`'s said
  "a long line from shortly before each change on it", it says each edit's
  first changed region shows as `edit`'s answer shows its change. So an
  agent with workspace tools sends changed tool definitions from its first
  request after upgrading.
