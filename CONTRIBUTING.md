# Contributing

Thanks for contributing to Portlock.

## Development Setup

Requirements:

- Node.js 20 or newer
- npm
- git

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Dry-run the package publish output:

```bash
npm pack --dry-run
```

## Making Changes

1. Create a branch from `main`.
2. Make the smallest change that solves the problem.
3. Add or update tests when behavior changes.
4. Update documentation when the public contract changes.

## Pull Requests

Before opening a PR, make sure:

- tests pass locally
- the README stays accurate
- `package.json` version changes only when you intentionally want to cut a release

PRs should include:

- what changed
- why it changed
- any compatibility or rollout concerns

## Release Notes

Portlock uses npm package versions as the public release contract.

- patch: bug fixes and non-breaking polish
- minor: new non-breaking functionality
- major: breaking changes to config, outputs, or CLI behavior
