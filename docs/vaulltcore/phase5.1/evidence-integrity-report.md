# Phase 5.1 — Evidence Integrity Report

**Date:** 2026-08-26
**Git SHA (current HEAD):** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc
**Git SHA (prior Phase 5.1 docs):** e31e5c0 (STALE — superseded; see §4)

---

## Discrepancies Found and Resolved

### 1. Soak Duration Mismatch (CRITICAL — prior report was itself wrong)

The earlier evidence-integrity narrative claimed the soak was **300 seconds (5 minutes)**
and asserted the raw file `sustained-soak-300s.json` contained `"durationSeconds": 300`.
That claim is **false**. The authoritative raw evidence actually contains:

```json
{
  "sha": "a06758ea42518fbbb296f041e699aaa236551c2a",
  "collectedAt": "2026-08-25T18:28:47.735Z",
  "durationSeconds": 30,
  "totalOps": 612,
  "errors": 0,
  "avgOpsPerSecond": 20.33,
  ...
}
```

**Arithmetic proof:** 612 total ops / 20.33 ops-per-second = **30.1 seconds**. The raw
evidence is internally consistent with **30 seconds**, NOT 300.

The misleading signals were:
- filename `sustained-soak-300s.json` (suggests 300s — WRONG label)
- harness default `PHASE5_SOAK_SECONDS ?? "300"` (default NOT used for this run)
- the prior evidence-integrity-report "correcting" the text to 300s (itself erroneous)

**Resolution:** The actual executed soak duration is **30 seconds**, run at a stable
queue depth of ~10,000 messages. The misleading filename is retained for traceability
but documented here as containing a 30-second run.

**Impact on verdict:** A 30-second soak is NOT a multi-hour qualification. Multi-hour
endurance remains **NOT EXECUTED / BLOCKED** (see acceptance report §18 and §24). The
soak still demonstrates 0 invariant violations at 10k depth for 30s; it does not qualify
hour-scale behavior.

### 2. Worker Saturation Description

| Source | Claim |
|--------|-------|
| Phase 5 acceptance report §9 | "saturation at ~4 workers" |
| `capacity-ladder-64.json` raw data | Peak throughput at 8 workers |

**Resolution:** The Phase 5 acceptance report's "saturation at ~4 workers" is imprecise.
Peak throughput is at **8 workers**, with degradation beginning at 16. The capacity report
(§37) provides the precise ladder.

### 3. Evidence File Naming

The soak evidence file is named `sustained-soak-300s.json` but contains a **30-second**
run. No rename applied (preserves raw provenance), but its true duration is documented
everywhere in this report as 30 seconds.

### 4. Git SHA Drift (CRITICAL)

Prior Phase 5.1 documents recorded **e31e5c0** as the Git SHA. The current repository
HEAD is **d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc**. The entire Phase 5.1 test suite was
re-executed at d4bbc12721b6 on 2026-08-26; every generated raw-evidence file records that
SHA in its `sha` field. All Phase 5.1 reports are hereby corrected to reference
**d4bbc12721b6**.

---

## Evidence Completeness Check (Phase 5.1 raw files)

Every Phase 5.1 experiment references a raw JSON file. On 2026-08-26, the suite was executed
and **all 33 referenced raw files were physically produced** in
`docs/vaulltcore/phase5/raw-results/` with a recorded `sha: d4bbc12721b6`.

| Evidence File | SHA Present | Timestamp Present | Verdict Present |
|---------------|-------------|-------------------|-----------------|
| retry-amplification-10/100/1000/10000.json | ✅ | ✅ | ✅ |
| retry-amplification-independent.json | ✅ | ✅ | ✅ |
| reconcile-single/idempotent-10x/idempotent-100x/concurrent-4x.json | ✅ | ✅ | ✅ |
| credential-scan-normal/checkpoints/malicious.json | ✅ | ✅ | ✅ |
| provider-boundary-core/adapters/require.json | ✅ | ✅ | ✅ |
| fencing-stale-worker/cas-reject/concurrent-cas-race/concurrent-lease/renewal-reject.json | ✅ | ✅ | ✅ |
| event-ordering/no-duplicate/replay-consistency/cursor-replay/restart-survival/cross-run-independence.json | ✅ | ✅ | ✅ |
| adv-backend-cross-read/runtime-cross-ops/1000-cross-contamination/idem-cross-tenant/queue-id-collision/concurrent-queue-ops.json | ✅ | ✅ | ✅ |
| crash-matrix-produced.json | ✅ | ✅ | ✅ |

All 33 Phase 5.1 raw evidence files contain SHA, timestamp, and verdict. No missing fields.

Phase 5 (prior) raw files remain present and unchanged (24 files).

---

## No Fake Evidence Detected (post-correction)

All raw evidence files in this qualification were produced by actual test execution on
2026-08-26 at SHA d4bbc12721b6. The earlier documentation errors (300s soak claim, stale
SHA) were documentation defects, not fabricated data files. The raw files themselves are
authentic and internally consistent on the corrected reading (30-second soak).

---

## Corrected Summary of Dispositions

| Item | Corrected Status |
|------|------------------|
| Soak duration | **30 seconds** (NOT 300) at ~10k depth |
| Multi-hour endurance | NOT EXECUTED / BLOCKED (sandbox + managed PG) |
| Phase 5.1 tests | 33/33 executed and PASS at SHA d4bbc12721b6 |
| Git SHA | d4bbc12721b6 (current HEAD) |
