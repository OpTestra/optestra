// Sortable orders table plus a deliberately messy control: "Show refunded
// orders" is a clickable <div> with no role, the kind of markup real apps ship.

const table = document.querySelector('[data-js="orders-table"]');
const body = table.tBodies[0];
const compare = {
  number: (a, b) => a.dataset.number.localeCompare(b.dataset.number),
  date: (a, b) => a.dataset.date.localeCompare(b.dataset.date),
  status: (a, b) => a.dataset.status.localeCompare(b.dataset.status),
  total: (a, b) => Number(a.dataset.total) - Number(b.dataset.total),
};

for (const button of table.querySelectorAll("button[data-sort]")) {
  button.addEventListener("click", () => {
    const header = button.closest("th");
    const direction = header.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    for (const th of table.tHead.rows[0].cells) th.setAttribute("aria-sort", "none");
    header.setAttribute("aria-sort", direction);
    const sign = direction === "ascending" ? 1 : -1;
    const rows = [...body.rows].sort((a, b) => sign * compare[button.dataset.sort](a, b));
    body.append(...rows);
  });
}

const toggle = document.querySelector('[data-js="toggle-refunded"]');
let showRefunded = false;
toggle.addEventListener("click", () => {
  showRefunded = !showRefunded;
  for (const row of body.querySelectorAll('tr[data-status="Refunded"]')) row.hidden = !showRefunded;
  toggle.textContent = showRefunded ? toggle.dataset.hide : toggle.dataset.show;
});
