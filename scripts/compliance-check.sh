#!/usr/bin/env bash
# Compliance gate (SPEC §10, §12.7). Fails the build if:
#  1. Prescriptive trading vocabulary appears in UI strings or alert templates.
#  2. Upstox order/GTT API endpoints appear anywhere in the codebase.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# --- 1. Prescriptive vocabulary in user-facing surfaces --------------------
SURFACES=()
[ -d apps/web/src ] && SURFACES+=("apps/web/src")
[ -f apps/engine/src/alerts/templates.ts ] && SURFACES+=("apps/engine/src/alerts/templates.ts")

if [ ${#SURFACES[@]} -gt 0 ]; then
  PATTERN='\b([Bb]uy|[Ss]ell|[Ee]ntry|[Ee]xit now|[Tt]arget price|[Ss]top[- ]?loss|SL hit|[Bb]ook profit)\b'
  if grep -rInE "$PATTERN" "${SURFACES[@]}" --include='*.ts' --include='*.tsx' 2>/dev/null; then
    echo "COMPLIANCE FAIL: prescriptive vocabulary found in user-facing strings (above)."
    fail=1
  fi
fi

# --- 2. Order API endpoints anywhere ---------------------------------------
if grep -rInE '/v[23]/(order|gtt)' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "COMPLIANCE FAIL: Upstox order/GTT endpoint reference found (above)."
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "Compliance check passed: descriptive-only surfaces, no order APIs."
fi
exit $fail
