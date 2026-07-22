// SPDX-License-Identifier: Apache-2.0
// Single source of truth for the harness version — baked into the binary at build,
// stamped into every database on open, and surfaced on /healthz so the control plane can
// read what a deployed agent is actually running.
//
// The compatibility contract (SemVer, MAJOR.MINOR.PATCH):
//   MAJOR — a BREAKING change: the HTTP seam (/v1/*), the config env contract, the vocab
//           shape, the operator-file contract, or an on-disk change beyond a forward-only
//           migration. A product must opt into a MAJOR bump deliberately.
//   MINOR — ADDITIVE, backward-compatible: new tools, new optional config/metadata, new
//           forward-only migrations that preserve existing data.
//   PATCH — fixes with no interface change.
//
// Guarantee for a deployed agent: upgrading the daemon binary from version X to any
// higher version only ever moves its database FORWARD (migrations are additive and
// transactional) and never touches its workspace, files, or persona — those live on the
// persistent volume, not in the binary. Downgrades that would open a newer-schema DB with
// an older binary are refused, not silently corrupted (see db.ts). Full policy and the
// upgrade/rollback runbook: the guide at https://deltaharness.dev.
export const HARNESS_VERSION = "0.2.0";
