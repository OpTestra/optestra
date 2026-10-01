---
"@optestra/decide": minor
"@optestra/cli": minor
---

Add the during-run decisions to `@optestra/decide`. `same_element` scores
identity signals with weights from a data file, never guesses "same", and puts
every signal's score in its evidence. `miss_action` implements the HEAL-1
healing ladder: block, no_heal, replay_fallback, refind, call_fixer. New helpers:
`decideSameElement`, `rankCandidates` (a clear match or `ambiguous`), `decideMiss`
and `missContext`. Eval sets for both tasks are built from the shop's correct vs
cosmetic builds and included in `decisions --eval`. When a model backend is
chosen, `decisions --eval` lifts the during-run limits so slow models can be
compared.
