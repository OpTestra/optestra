# Recorded System One examples

Used by `src/node/systemone/wire.test.ts`. Never regenerate them with real keys in the files.

| File | Source |
|---|---|
| `request-three-questions.json` | The request body sent for the recordings below (state + 3 questions). |
| `jev-response.json` | **Recorded** from `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest` (answered by `jev-1.13.0`), 2026-09-26. |
| `jev-models.json` | **Recorded** from `GET /v1/models`, 2026-09-26. |
| `jev-error-401.json` | **Recorded**: invalid key. |
| `jev-error-400.json` | **Recorded**: unknown model. |
| `jev-error-422.json` | **Recorded**: missing `state`. Note that TypeSafe echoes the request body in `detail[].input`; our error messages must never include it. |
| `kev-response.json` | **Doc-derived** from the Kev README (Kev-4B on an Apple M5), not recorded: no Kev server here. |
| `ollaya-decide.json` | **Recorded** from Ollaya 0.6.1 `POST /api/decide`, model `laya:typed-decisions` (warm), 2026-09-26. |
| `ollaya-v1.json` | **Recorded** from Ollaya 0.6.1 `POST /v1/systemone`, same request. |
| `ollaya-tags.json` | **Recorded** from Ollaya 0.6.1 `GET /api/tags`. |
| `ollaya-error-model-not-found.json` | **Recorded**: unknown model. |
| `ollaya-error-invalid.json` | **Recorded**: `criteria` given as a string for a noul. |
