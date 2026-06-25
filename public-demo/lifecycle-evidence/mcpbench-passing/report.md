# MCPBench / AgentCert Report

MCPBench: 100/100
AgentCert: Platinum
Passed: yes
Critical violations: 0
High violations: 0

## Reproduce

`python scripts/generate_sample_reports.py`

## Findings

No critical or high runtime behavior-chain violations were detected.

## Scorers

- `runtime_sequence_safety`: 100/100 (pass)
- `schema_quality`: 85/100 (pass)

## Safety Note

This report is based on benign local synthetic fixtures. It is not a security guarantee.
