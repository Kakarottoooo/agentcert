# Adapter compatibility

AgentCert tests five onboarding contracts (`browser`, `coding`, `mcp`, `workflow`, and `data`) against the previous stable CLI and the current npm `latest` tag every day.

The matrix checks fresh initialization, generated-file syntax, and an in-place `--force` upgrade from `0.5.1` to `latest`. A capability that did not exist in the earlier release is reported as `unsupported`, not as a regression; the upgrade must create and validate the new adapter. The five independent reference repositories add a production boundary: each installs only the public npm package and writes one synthetic, idempotent envelope to the Hosted Control Plane.

This matrix proves that the documented adapter surface can still initialize and ingest a bounded synthetic event. It does not prove compatibility with every framework release or the business correctness of a customer workflow.
