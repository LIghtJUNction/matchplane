# ADR 0001: Modular Rust monorepo

- Status: Accepted
- Date: 2026-08-14

## Decision

Use one Cargo workspace with infrastructure-independent library crates and independently
deployable service binaries. Do not split repositories until ownership or release cadence proves
that a boundary needs it.

## Consequences

Cross-crate changes remain atomic and CI can enforce one lint and dependency baseline. Service
images and Linux packages can still contain separate binaries.
