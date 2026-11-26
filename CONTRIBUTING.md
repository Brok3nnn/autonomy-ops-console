# Contributing

Thanks for your interest. This is a small portfolio project, so issues and focused pull requests are the best way to help.

## Setup

You need Node.js 20 or newer (CI uses Node 24) and npm.

```bash
npm ci
npm run dev   # http://localhost:3000
```

No API keys are needed. The browser code in `public/js/` is plain ES modules; there is no build step.

## Before you open a pull request

Run every check that CI runs:

```bash
npm run check   # ESLint, Prettier check and the node:test suite
```

`npm run format` fixes formatting. Tests must not touch the network: inject a fake `fetch` as `test/road-risk.test.js` does. New logic should go into a DOM-free module with a test where possible.

Do not run `npm run routes:fetch` in automation. It calls the public OSRM servers, which allow at most one request per second and no heavy use.

## Commit messages

Use the imperative mood and keep the summary line under about 72 characters, for example `Show retry time for rate-limited providers`. Add a body when the reason for a change is not obvious from the diff.

## Proposing changes

- For bugs, open an issue with the bug report template and steps to reproduce.
- For larger changes or new features, open a feature request first so the approach can be discussed before you write code.
- Keep pull requests small and focused on one change, and fill in the pull request template.

By contributing you agree that your contributions are licensed under the MIT License and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
