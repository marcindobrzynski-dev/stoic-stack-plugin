# Experiments

`experiments/jev/` is the structured-state Jev classifier trial on this branch.
The Jev trial is not the default classifier
(`DEFAULT_CLASSIFIER_MODEL` is `claude-haiku-5-5` in
`src/io/config/config.js`). On this branch, `src/` imports from it:

- `src/hooks/stop.js` imports `readTurns` from
  `experiments/jev/transcript.js` and `JEV_MODEL_PREFIX` from
  `experiments/jev/constants.js`.
- `src/io/classifier.js` imports `runJev` from `experiments/jev/runner.js`,
  and `JEV_GENERAL_CATEGORY` and `JEV_MODEL_PREFIX` from
  `experiments/jev/constants.js`.

`VETO_COOLDOWN_RATIO` lives in `src/io/config/config.js`.
