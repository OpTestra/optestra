# Checking the meter against the bill (COST-0)

The meter (`bench --meter`) prices what each task measured with the list prices
in `prices.yaml`. The bill is what Google charged. They should agree within a
few percent on the items that carry the `cost-run=<id>` label, once free tiers
are added back.

## Turn on the export (once, today)

Console → Billing → Billing export → BigQuery export → **Standard usage cost**:
pick (or create) a dataset, for example `billing_export` in the project. Data
starts arriving within a day and covers usage from when it was turned on; it
can't backfill. Tomorrow's run is the first one it can show.

## What carries the label

| Resource | Labelled | How to find it in the export |
|---|---|---|
| Cloud Run Job (its executions' vCPU-s and GiB-s) | yes, the job's labels | `labels` contains `cost-run` |
| Cloud Storage bucket (storage, operations) | yes, bucket labels | `labels` contains `cost-run` |
| Artifact Registry repo (storage) | yes, repo labels | `labels` contains `cost-run` |
| Secret Manager secret (option a) | yes | `labels` contains `cost-run` |
| Spot VM and its disk (Android, MOB-3) | yes, `--labels` on create | `labels` contains `cost-run` |
| Cloud Build | **no** (builds can't carry billing labels) | `service.description = 'Cloud Build'` in the run's time window |
| Network egress (downloading results) | no | small; `sku.description` like 'Network Internet Egress' in the window |

## The query

```sql
-- Replace the table and the id. Costs are before credits; credits (free tiers) are listed apart.
DECLARE cost_run STRING DEFAULT 'baseline-20261002';

SELECT
  service.description AS service,
  sku.description AS sku,
  SUM(usage.amount_in_pricing_units) AS usage,
  ANY_VALUE(usage.pricing_unit) AS unit,
  ROUND(SUM(cost), 6) AS cost_before_credits,
  ROUND(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 6) AS credits
FROM `PROJECT.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'cost-run' AND l.value = cost_run)
  AND usage_start_time >= TIMESTAMP('2026-10-02')
GROUP BY service, sku
ORDER BY cost_before_credits DESC;

-- Cloud Build has no labels: take the builds in the run's window.
SELECT sku.description, SUM(usage.amount_in_pricing_units) AS minutes, ROUND(SUM(cost), 6) AS cost
FROM `PROJECT.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE service.description = 'Cloud Build'
  AND usage_start_time BETWEEN TIMESTAMP('2026-10-02 00:00:00') AND TIMESTAMP('2026-10-03 00:00:00')
GROUP BY 1;
```

## Comparing

Take `bench/results/<date>-cloud-baseline.json`:

| Meter field | Bill rows to add up |
|---|---|
| `totals.compute` | Cloud Run: 'CPU Allocation Time' (vCPU-s) and 'Memory Allocation Time' (GiB-s), us-east4 |
| `totals.storage` | Cloud Storage: 'Standard Storage US East4' + 'Class A Operations' |
| `oneOff.build` | Cloud Build: 'Build time' minutes |
| `totals.androidVm` | Compute Engine: 'Spot Preemptible N2 Instance Core/Ram' + 'Balanced PD Capacity' |
| `idleMonthly` items | Artifact Registry storage, Secret Manager versions (prorated for the day) |

What to expect:
- **Cost before credits ≈ the meter's list price.** The usage units should match
  the meter's seconds: Cloud Run's vCPU-s ≈ Σ billed seconds × vCPU over the
  run's tasks. If the bill's seconds are higher, the meter is missing container
  start time; check `measurements.containerStartMs`.
- **Credits ≈ −cost** for Cloud Run and Cloud Build at this scale (free tiers),
  so the net bill is about $0. The meter reports the list price on purpose: the
  free tier is per billing account and runs out at product scale.
- **Spot VMs** are priced when they run and the price moves. A difference of a
  few percent from `prices.yaml`'s `compute.spot` is the price moving; update
  `prices.yaml` (with its `checked` date) if it matters.
- **AI** isn't on the Google bill: the Anthropic console (option a) or nothing
  (option b, the subscription). The meter's `ai.listUsd` is at list prices either way.

Record the comparison (meter vs bill, per row) next to the baseline in
`bench/results/` so the next cost run can be checked the same way.
