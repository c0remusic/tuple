# Contributing to Tuple

Thanks for your interest in Tuple — a Max for Live chord-grid instrument for Ableton Live.

Right now the most valuable way to help is **feedback**: bug reports and feature requests.

## Report a bug
Open a [Bug report](https://github.com/c0remusic/tuple/issues/new?template=bug_report.yml).
Please include your Tuple version (see the device's **About** panel), your Ableton Live version, and your OS (Windows / macOS).

## Request a feature
Open a [Feature request](https://github.com/c0remusic/tuple/issues/new?template=feature_request.yml).
Describe the problem you're trying to solve, not only the solution — it helps us find the best fit.

## Ask a question / chat
Join the community on [Discord](https://discord.gg/N52jGhGE).

## Code contributions
Tuple is a Max for Live device. A few things to know before opening a pull request:

- `device/tuple.amxd` is a **binary Max patch, hand-edited inside Max** — it does not diff or merge like text. Please **open an issue first** to discuss any change that touches the patch.
- The harmonic logic lives in the loose `.js` files (`device/chord_engine.js` is the single source of truth). These are the most contribution-friendly — keep them **ES5** (Max's JS engine has no ES6: no `let`/`const`, arrow functions, template strings, `Set`/`Map`).
- Keep the UI (`device/ui/`) and the engine separate; the engine stays the source of truth.

By contributing, you agree your contributions are licensed under the repository's [MIT License](../LICENSE).
