# Contributing

Thanks for your interest!

- **Issues are very welcome:** bug reports, false positives or missed values (described with synthetic examples),
  setup problems and ideas.
- **Code contributions aren't being accepted yet.** The project may offer a commercial licence alongside the
  AGPL-3.0 in future, and that needs a contributor licence agreement, which isn't set up yet. Please open an issue
  to discuss a change instead.
- **Never include real email content, addresses, tokens or other personal data** in issues. Write synthetic
  examples instead (see `eval/redaction-set.json`).
- Security problems: see [SECURITY.md](SECURITY.md), not public issues.

For maintainers: run `npm run typecheck` and `npm test`, and for classifier or detector changes, benchmark on the
dev split and record the before/after numbers (see "Dev, validation and test splits" in the README).
