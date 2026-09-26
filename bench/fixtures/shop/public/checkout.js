import { api } from "./common.js";

// The card fields live in an iframe (like a payment provider's hosted fields).
// The page asks the frame for a card token, then subscribes with it.

const form = document.querySelector('[data-js="checkout-form"]');
const frame = document.querySelector('[data-js="card-frame"]');
const error = document.querySelector('[data-js="checkout-error"]');
const button = form.querySelector('button[type="submit"]');
let waiting = null;

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  waiting?.(event.data);
  waiting = null;
});

function requestToken() {
  return new Promise((resolve) => {
    waiting = resolve;
    frame.contentWindow.postMessage({ type: "tokenize" }, location.origin);
  });
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  error.hidden = true;
  const card = await requestToken();
  if (card.error) {
    showError(card.error);
  } else {
    const result = await api("/api/subscribe", { plan: form.dataset.plan, token: card.token });
    if (result.ok) {
      location.assign(result.data.redirect);
      return;
    }
    showError(result.data.error);
  }
  button.disabled = false;
});
