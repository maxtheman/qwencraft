# Versioning

`qwencraft` uses semantic versioning, but it is currently in the `0.x` phase.

Current version:

- `0.1.0`

## Pre-1.0 policy

While the project is still exploratory:

- `0.x.0` means a meaningful milestone with behavior, tooling, or architecture changes worth calling out.
- `0.0.x` style patch bumps are for smaller fixes, doc improvements, and non-breaking internal cleanup.
- breaking changes are still allowed before `1.0.0`, but they should be called out clearly in release notes.

Practical rule:

- use `patch` for focused fixes or doc-only updates
- use `minor` for new capabilities, tool-surface changes, or notable runtime/UI shifts
- reserve `1.0.0` for the point where the model loop, harness, and core interaction contract feel stable enough to treat as a real baseline

## How to bump

Update the package version locally without creating a Git tag:

```bash
npm run version:patch
npm run version:minor
npm run version:major
```

These scripts only update `package.json`.

## Release checklist

1. Run:

```bash
npm test
npm run build
```

2. Bump the version using one of the scripts above.
3. Add a short note to the changelog section below or to the commit/PR description.
4. Commit the version bump.
5. Create an annotated Git tag if you want a durable release point:

```bash
git tag -a v0.x.y -m "v0.x.y"
git push origin main --tags
```

## Changelog seed

### 0.1.0

Initial public `qwencraft` baseline:

- local LM Studio-driven builder sandbox
- Effect runtime and headless harness
- beacon-based world interaction
- debug/history UI and trace capture
- strict TypeScript baseline
