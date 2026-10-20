# Contributing

This repository mirrors the open parts of a private monorepo. A workflow there rewrites this repository's `main` on every change, keeping the history of these paths, so nothing here is edited directly.

- **Issues** are welcome here, for the CLI, the MCP server, the rules and the cost model, and the docs. Security reports go to security@buildhound.sh, not to a public issue.
- **Pull requests** are read here and applied upstream by the maintainers, with your authorship kept. Because `main` is rewritten from upstream, a merged change appears here on the next sync rather than as a merge of your branch.
- **Rates and prices** live in `packages/core/src/cost/rates`; every rate needs a `source` and a `verified_at`. A finding without evidence, an estimate, a confidence and a diff is not complete.
- **YAML** is never edited by string replacement: parse it, change the document, write it back, so comments survive. Every rule fix has a snapshot test.

Run `pnpm install`, then `pnpm test` and `pnpm typecheck`, before opening a pull request.
