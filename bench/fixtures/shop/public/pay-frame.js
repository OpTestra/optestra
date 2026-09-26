import { api } from "./common.js";

const form = document.querySelector('[data-js="card-form"]');

window.addEventListener("message", async (event) => {
  if (event.origin !== location.origin || event.data?.type !== "tokenize") return;
  const fields = Object.fromEntries(new FormData(form));
  const result = await api("/pay/tokens", fields);
  const reply = result.ok ? { token: result.data.token } : { error: result.data.error };
  event.source.postMessage(reply, event.origin);
});
