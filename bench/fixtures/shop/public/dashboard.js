import { api, toast } from "./common.js";

// Projects load after a short fixed delay, like a slow API (exercises waits).
const LOAD_DELAY_MS = 600;

const list = document.querySelector('[data-js="project-list"]');
const dialog = document.querySelector('[data-js="create-dialog"]');
const form = document.querySelector('[data-js="create-form"]');
const error = document.querySelector('[data-js="create-error"]');
const openButton = document.querySelector('[data-js="open-create"]');
let projects = [];

function item(text, role) {
  const li = document.createElement("li");
  li.textContent = text;
  if (role) li.setAttribute("role", role);
  return li;
}

function render() {
  list.replaceChildren(
    ...(projects.length ? projects.map((p) => item(p.name)) : [item("No projects yet.")]),
  );
  list.setAttribute("aria-busy", "false");
}

const loaded = new Promise((resolve) => {
  setTimeout(async () => {
    const result = await api("/api/projects");
    if (result.ok) {
      projects = result.data.projects;
      render();
    } else {
      list.replaceChildren(item("Couldn't load projects. Reload the page to try again.", "alert"));
      list.setAttribute("aria-busy", "false");
    }
    resolve();
  }, LOAD_DELAY_MS);
});

openButton?.addEventListener("click", () => {
  form.reset();
  error.hidden = true;
  dialog.showModal();
});

document.querySelector('[data-js="cancel-create"]').addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  // Never race the initial load: requests reach the API in the same order every time.
  await loaded;
  const name = new FormData(form).get("name");
  const result = await api("/api/projects", { name });
  if (result.status === 400) {
    error.textContent = result.data.error;
    error.hidden = false;
    return;
  }
  dialog.close();
  if (!result.ok) {
    toast("Couldn't create project. Please try again.", "error");
    return;
  }
  projects.push(result.data.project);
  render();
  toast("Project created");
});
