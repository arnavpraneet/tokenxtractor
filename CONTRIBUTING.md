# Contributing

Thanks for your interest in contributing to tokenxtractor!

## Prerequisites

- Node.js >= 18
- pnpm >= 9

## Setup

```bash
git clone <repo-url>
cd tokenxtractor
pnpm install
```

## Building

```bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter @tokenxtractor/core build
pnpm --filter tokenxtractor build
```

## Testing

```bash
# Run all tests
pnpm test

# Run core package tests only
pnpm --filter @tokenxtractor/core test
```

## Project Structure

```
packages/
  core/   — shared pipeline (normalizer, redactor, formatter, uploader, state)
  cli/    — tokenxtractor CLI (commander.js + inquirer.js)
```

## Making Changes

1. Fork the repository and create a branch from `main`
2. Make your changes, following existing code style
3. Add or update tests for any changed behaviour in `packages/core`
4. Run `pnpm build` and `pnpm test` to verify everything passes
5. Open a pull request with a clear description of what changed and why

## Reporting Issues

Please open an issue describing the problem, the expected behaviour, and steps to reproduce.

## Privacy Note

This tool processes potentially sensitive AI session data. Any changes to the normalizer, redactor, or uploader must be carefully reviewed to ensure no personal information leaks into exported datasets.
