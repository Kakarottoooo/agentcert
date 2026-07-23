# Adapter compatibility

AgentCert tests five onboarding contracts (`browser`, `coding`, `mcp`, `workflow`, and `data`) against the previous stable CLI and the current npm `latest` tag every day.

The matrix checks fresh initialization, generated-file syntax, and an in-place `--force` upgrade from `0.5.1` to `latest`. A capability that did not exist in the earlier release is reported as `unsupported`, not as a regression; the upgrade must create and validate the new adapter. The five independent reference repositories add a production boundary: each installs only the public npm package and writes one synthetic, idempotent envelope to the Hosted Control Plane.

This matrix proves that the documented adapter surface can still initialize and ingest a bounded synthetic event. It does not prove compatibility with every framework release or the business correctness of a customer workflow.

## Semantic adapter matrix

The onboarding matrix above tests generated files. The separate [semantic calibration](semantic-calibration.md) tests whether public, source-pinned tool contracts from five external projects map to the intended browser, coding, data, messaging, and finance capability packs.

Run it with:

```bash
npm run semantic-calibration
```

The generated report records exact matches, misclassifications, false-known controls, and the false-unknown rate. These two matrices answer different questions and should not be combined into one score.
