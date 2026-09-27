## Product: Failed · demo-shop · staging

| Passed | Healed | Failed | Flaky | Blocked |
|---:|---:|---:|---:|---:|
| 1 | 0 | 1 | 0 | 0 |

2 tests in 16.1s · 0 AI calls · \$0.00

### What went wrong

**Failed:** Expected order total '\$90.00', found '\$100.00'  
product bug · affects 1 test · [screenshot](artifact:tests/tests__checkout__discount-code/2/steps/2-after.png)
Expected `'$90.00'`, actual `'$100.00'`
- Discount code takes 10% off (`tests/checkout/discount-code.md`, step 3)

<details><summary>AI use per test</summary>

| Test | AI calls | Cost | History |
|---|---:|---:|---|
| Discount code takes 10% off | 0 | \$0.00 | used AI 0 times in its last 20 runs |
| Guest checkout | 0 | \$0.00 | used AI 0 times in its last 20 runs |

</details>

<details><summary>All tests (2)</summary>

| Verdict | Test | Time | AI calls | Cost |
|---|---|---:|---:|---:|
| Failed | Discount code takes 10% off | 12.7s | 0 | \$0.00 |
| Passed | Guest checkout | 3.3s | 0 | \$0.00 |

</details>

See the full report: `product report` · run `01M3EG7AG0M0AHEMTHAS09ZS7Y`
