import { api, toast } from "./common.js";

const profile = document.querySelector('[data-js="profile-form"]');
profile.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { name, timezone } = Object.fromEntries(new FormData(profile));
  const result = await api("/api/profile", { name, timezone });
  toast(result.ok ? "Profile saved" : result.data.error, result.ok ? "success" : "error");
});

const avatarForm = document.querySelector('[data-js="avatar-form"]');
avatarForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = avatarForm.querySelector('input[type="file"]').files[0];
  if (!file) {
    toast("Choose an image first.", "error");
    return;
  }
  const result = await api("/api/avatar", undefined, {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
  if (!result.ok) {
    toast(result.data.error, "error");
    return;
  }
  const img = document.createElement("img");
  Object.assign(img, { src: result.data.src, alt: "Your avatar", width: 96, height: 96 });
  img.dataset.js = "avatar-img";
  document.querySelector('[data-js="avatar-slot"]').replaceChildren(img);
  toast("Avatar updated");
});

const deleteDialog = document.querySelector('[data-js="delete-dialog"]');
document
  .querySelector('[data-js="open-delete"]')
  .addEventListener("click", () => deleteDialog.showModal());
document
  .querySelector('[data-js="cancel-delete"]')
  .addEventListener("click", () => deleteDialog.close());
