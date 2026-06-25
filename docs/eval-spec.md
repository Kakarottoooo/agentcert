# Eval Spec

Eval suites are YAML files containing task definitions.

Required task fields:

- `id`
- `description`
- `user_prompt`

Optional fields:

- `expected_tools`
- `forbidden_tools`
- `allowed_high_risk_tools`
- `canaries`
- `success_criteria`
- `metadata`

The offline MVP includes deterministic scripted agents. Provider-backed runs are future optional extras and must not be required for default CI.

