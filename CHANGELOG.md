# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-26

### Added

- First public release of the Autonomy Ops supervision console: Live Operations, Area Approval, Incident Handling and Transmission Health views over a simulated fleet of 100 vehicles on 17 Austrian road corridors.
- Road-risk feed (`/api/road-risk`) from Open-Meteo and GDELT with per-provider status (live, cached, unavailable), short timeouts, backoff that honours `429` and `Retry-After`, and CDN cache headers.
- Pre-computed OSRM route cache for all corridors and `npm run routes:fetch` to rebuild it.
- Unit tests with `node:test`, ESLint, Prettier and a GitHub Actions workflow.

[1.0.0]: https://github.com/Brok3nnn/autonomy-ops-console/releases/tag/v1.0.0
