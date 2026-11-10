- The `context-refusal` ops alert raised when a refused compile fails its
  turn ends "if this persists, raise contextBudgetTokens." It no longer also
  names `overBudgetGraceRatio`, a context-manager strategy option. The
  passthrough strategies don't read it, so raising it changed nothing there.
  Under the autobiographical strategy, raising it raises the limit a compile
  is refused at, which raising `contextBudgetTokens` already does.
