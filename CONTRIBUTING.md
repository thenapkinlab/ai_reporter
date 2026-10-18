# Contributing

Thanks for your interest! Issues and pull requests are welcome.

- **Sign off your commits** (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/):
  that you wrote the change or have the right to submit it under this project's licence.
- **Never include real email content, addresses, tokens or other personal data** in issues, tests or fixtures.
  Write synthetic examples instead (see `eval/redaction-set.json`).
- Run `npm run typecheck` and `npm test` before opening a pull request. For changes to the classifier prompt or
  detectors, run the benchmarks on the dev split and include the before/after numbers (see "Dev, validation and
  test splits" in the README). Don't tune on the validation or test splits.
