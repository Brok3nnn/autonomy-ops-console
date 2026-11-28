# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The danger gauge's colour zones now change at 45 and 75, like the Stable, Watch closely and Emergency profile labels.
- Transmission node actions no longer create road signals in Area Approval. Node ids are now TX-1 to TX-4, so they no longer match the zone codes A-01 to A-04.
- The test suite passes on Node.js 22. The upstream-timeout test is no longer cancelled before its timer fires.

### Changed

- Node.js 22 or newer is required, because Node.js 20 is end-of-life. CI runs on Node 22 and 24.
- The header says the fleet is simulated, and Area Approval signals show their source as simulated. Simulated weather signals no longer name Open-Meteo as their source.
- The map credits the Austria boundary (geoBoundaries / BEV, CC BY-SA 2.0), and the README states the licence of each data file.
- The road danger panel links to Open-Meteo and gives the refresh interval.
- Transmission bandwidth is shown in Gbit/s.
- ESLint 10 replaces ESLint 9, which is no longer supported.
- The left sidebar lists what the console itself does (Console Tools) instead of an Authority Scope list.

## [1.0.0] - 2026-11-26

### Added

- First public release of the Autonomy Ops supervision console: Live Operations, Area Approval, Incident Handling and Transmission Health views over a simulated fleet of 100 vehicles on 17 Austrian road corridors.
- Road-risk feed (`/api/road-risk`) from Open-Meteo and GDELT with per-provider status (live, cached, unavailable), short timeouts, backoff that honours `429` and `Retry-After`, and CDN cache headers.
- Pre-computed OSRM route cache for all corridors and `npm run routes:fetch` to rebuild it.
- Unit tests with `node:test`, ESLint, Prettier and a GitHub Actions workflow.

[Unreleased]: https://github.com/Brok3nnn/autonomy-ops-console/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Brok3nnn/autonomy-ops-console/releases/tag/v1.0.0
