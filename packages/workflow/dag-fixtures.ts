/**
 * Shared DAG fixtures for distributed tests (Phase 4.1).
 *
 * A → B
 * A → C → D
 * A → E
 *
 * `A` is the root. `B`, `C`, `D`, `E` are all blocked until `A` completes.
 * `D` additionally depends on `C`. The scheduler must release A first, then
 * B/C/E in parallel, then D once C finishes.
 */

import type { DagSpec } from "./dag";

export const DAG_A_B_C_D_E: DagSpec = {
  nodes: [
    { name: "A", specialist: "default", dependsOn: [], input: { node: "A" } },
    {
      name: "B",
      specialist: "default",
      dependsOn: ["A"],
      input: { node: "B" },
    },
    {
      name: "C",
      specialist: "default",
      dependsOn: ["A"],
      input: { node: "C" },
    },
    {
      name: "D",
      specialist: "default",
      dependsOn: ["C"],
      input: { node: "D" },
    },
    {
      name: "E",
      specialist: "default",
      dependsOn: ["A"],
      input: { node: "E" },
    },
  ],
};
