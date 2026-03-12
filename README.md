# Portlock

Portlock gives each git worktree a deterministic local runtime identity.

From one worktree claim it derives:

- service ports
- service URLs
- namespace values
- machine-readable metadata

## Status

This repository currently implements the first working CLI for the RFC's v1 surface:

- `portlock init`
- `portlock env`
- `portlock status`
- `portlock release`
- `portlock cleanup`
- `portlock current --json`
- `portlock resolve <service>`

## Install

For local development:

```bash
npm link
```

Without installing:

```bash
node ./src/cli.js init
```

After publishing:

```bash
npm install -g portlock
```

Or run it without a global install:

```bash
npx portlock init
```

## Config

Create a `.portlock.json` file in your repo root:

```json
{
  "basePort": 3000,
  "step": 100,
  "stripPrefixes": ["users/john/", "branches/"],
  "services": {
    "api": {
      "offset": 0,
      "env": {
        "API_PORT": "{port}",
        "API_HOST": "0.0.0.0",
        "API_ORIGIN": "http://127.0.0.1:{port}"
      }
    },
    "web": {
      "offset": 1,
      "env": {
        "WEB_PORT": "{port}",
        "WEB_ORIGIN": "http://127.0.0.1:{port}",
        "NEXT_PUBLIC_API_URL": "http://127.0.0.1:{api}"
      }
    }
  },
  "namespace": {
    "env": {
      "PORTLOCK_NAMESPACE": "app:{claim}"
    }
  },
  "metadata": {
    "env": {
      "PORTLOCK_CLAIM": "{claim}",
      "PORTLOCK_BASE": "{base}",
      "PORTLOCK_LABEL": "{label}"
    }
  }
}
```

## Behavior

- `init` claims a unique base range on the current machine and writes `.env.portlock` plus `.portlock/meta.json`
- `env` prints the derived environment for the current active claim
- `status` shows all active claims on the machine
- `cleanup` removes claims for worktrees that no longer exist

## How Worktrees Coordinate

Each worktree discovers its own runtime identity locally.

When you run `portlock init` inside a worktree, Portlock:

1. reads the current git context for that worktree
2. takes a machine-global lock
3. checks the shared claim store at `~/.portlock/lock.json`
4. reuses or assigns a base range
5. writes local outputs into that worktree

That means different feature branches do not need to know about each other directly. They only coordinate through the shared machine-level claim store during `init`.

Example:

```text
/Users/john/code/meridian              branch=main      -> base 3000
/Users/john/code/meridian-mer-123      branch=mer-123   -> base 3100
/Users/john/code/meridian-mer-124      branch=mer-124   -> base 3200
```

After initialization, each worktree has its own local files:

- `.env.portlock`
- `.portlock/meta.json`

Those files are what local scripts and agents consume. The branch name helps derive the claim label, but collision avoidance comes from the shared machine-level store.

## Notes

- Port assignment is machine-global, not repo-local
- Claims are tracked with repo metadata for cleanup and display
- This version does not provision databases, run processes, or mutate hostnames

## Publishing

If the package name is still available, the release flow is:

```bash
npm test
npm login
npm publish
```

For a dry run:

```bash
npm pack --dry-run
```

GitHub Actions workflows are included for CI and publishing:

- `CI` runs tests on push and pull requests
- `Publish` is a manual workflow (`workflow_dispatch`) that runs tests and publishes to npm

Before using the publish workflow, add `NPM_TOKEN` as a repository secret.
