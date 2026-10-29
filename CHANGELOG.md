# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - YYYY-MM-DD

### Added

- Automatic Stoic Pause at the end of a turn, with Reflect, Skip and Defer.
- Manual reflection with `/stoic-stack:stoic-reflect`, with Keep and Correct.
- Setup skill `/stoic-stack:stoic-setup` with three presets: `calm`, `balanced` and `vigilant`.
- Decision Bank for kept and corrected decisions.
- Critical Paths that start a pause candidate straight away.
- Classifier veto using Claude Haiku 5.5 (`claude-haiku-5-5`).
- Opt-in Jev classifier experiment, with a silent fallback to Claude Haiku 5.5 (`claude-haiku-5-5`).
