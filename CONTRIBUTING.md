# Contributing to Delta Harness

Thanks for your interest! Delta Harness is a lean, product-neutral agent runtime, and we keep
it that way on purpose.

## Ground rules

1. **Lean over sprawling.** The least amount of code that just works. New engine surface is
   rare and must be **product-neutral** — the engine names no product (there's a test that
   enforces this).
2. **Zero runtime deps** until one genuinely earns its place (exact pins, committed lockfile).
3. **Ground changes in real tests.** `bun test` + `bash scripts/smoke.sh` against a running
   server before calling anything done.

## Getting started

```sh
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

Requires **Bun ≥ 1.3**.

## Pull requests

- Keep PRs focused; one concern per PR.
- Add or update tests for behavior changes.
- Run `bun run lint` and `bun run typecheck` before pushing.
- Describe the change and how you verified it.

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/) instead of a CLA. Sign off each commit:

```sh
git commit -s -m "your message"
```

`-s` adds a `Signed-off-by: Your Name <you@example.com>` line certifying you wrote the code or
have the right to submit it under the project's license.

## License

By contributing, you agree your contributions are licensed under the project's
[Apache 2.0](./LICENSE) license. Please also read [`TRADEMARKS.md`](./TRADEMARKS.md) — the code
is open; the names are not.
