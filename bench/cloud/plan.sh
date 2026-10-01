#!/usr/bin/env bash
# Prints every resource the cost run would create and the expected $, from
# plan.json and prices.yaml. Creates nothing and calls no cloud API.
#   COST_RUN=baseline-20261002 bench/cloud/plan.sh [--json]
. "$(dirname "$0")/common.sh"
node "$CLOUD_DIR/plan.ts" "$@"
