import { expect, goToNav, label, test } from "../fixtures.js";

test("sort-orders", async ({ page, spec }) => {
  const table = page.getByRole("table", { name: "Your orders" });
  // Each order row starts with a row header (its order number).
  const orders = table.getByRole("rowheader");
  const sortByTotal = () => table.getByRole("button", { name: "Total" }).click();
  await spec.step(1, () => goToNav(page, "Orders"));
  await spec.step(2, () => expect(orders).toHaveCount(5));
  await spec.step(3, sortByTotal);
  await spec.step(4, () => expect(orders.first()).toHaveText("A-1002"));
  await spec.step(5, sortByTotal);
  await spec.step(6, () => expect(orders.first()).toHaveText("A-1004"));
  // A clickable <div> with no role: only its text finds it.
  await spec.step(7, () => page.getByText(label.showRefunded).click());
  await spec.step(8, () => expect(orders).toHaveCount(6));
});
