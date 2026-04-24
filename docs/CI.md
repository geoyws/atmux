# CI setup

A GitHub Actions workflow template is tracked outside the repo (the default
OAuth token atmux is pushed with doesn't hold the `workflow` scope). Copy it
into place locally once your gh token has `workflow` scope:

```bash
gh auth refresh -s workflow
```

Then create `.github/workflows/test.yml` with:

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install deps
        run: |
          sudo apt-get update
          sudo apt-get install -y tmux jq bats shellcheck

      - name: shellcheck
        run: |
          shellcheck -x -e SC1091,SC2154,SC2155,SC2016,SC2034 bin/atmux lib/*.sh tests/helpers/*.bash

      - name: bats unit
        run: bats tests/unit/

      - name: bats e2e
        run: bats tests/e2e/
```

Until then, `./tests/run.sh --shellcheck --jobs 4` gives you the same three
checks locally — and every commit to this repo was run through it.
