// Shared helpers for the shop's pages. Same-origin requests only.

export function toast(message, kind = "success") {
  const box = document.querySelector('[data-js="toasts"]');
  const item = document.createElement("p");
  item.className = `toast toast-${kind}`;
  item.textContent = message;
  if (kind === "error") item.setAttribute("role", "alert");
  box.append(item);
  setTimeout(() => item.remove(), 5000);
}

export async function api(path, body, init = {}) {
  const options = { credentials: "same-origin", ...init };
  if (body !== undefined && !(body instanceof Blob)) {
    options.method = options.method ?? "POST";
    options.headers = { "content-type": "application/json", ...options.headers };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}
