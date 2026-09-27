## Product: Healed · demo-shop · local

| Passed | Healed | Failed | Flaky | Blocked |
|---:|---:|---:|---:|---:|
| 0 | 1 | 0 | 0 | 0 |

1 test in 6.4s · 1 AI call · \$0.0184

<details><summary>Fixes to review (1)</summary>

- Add a product to the cart, step 2: locator `getByRole('button', { name: 'Add to cart' })` → `getByRole('button', { name: 'Add to bag' })` (confidence 82%, cosmetic; role match 100%, position 90%, text match 55%)

</details>

<details><summary>AI use per test</summary>

| Test | AI calls | Cost | History |
|---|---:|---:|---|
| Add a product to the cart | 1 | \$0.0184 | used AI 1 time in its last 10 runs |

</details>

<details><summary>All tests (1)</summary>

| Verdict | Test | Time | AI calls | Cost |
|---|---|---:|---:|---:|
| Healed | Add a product to the cart | 6.3s | 1 | \$0.0184 |

</details>

See the full report: `product report` · run `01M3EFN0J0FQBKEWDYW4JQ19PW`
