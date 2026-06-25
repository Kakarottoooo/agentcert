# AgentCert Evidence Report

Subject: tripwire-brittle-reference-agent
Generated: 2026-06-25T07:48:10.693Z
Verdict: FAIL
Score: 44
Level: Not certified

## Results

- tripwire-ci: FAIL (44/100, pre-release)
  Tripwire CI gate failed.

## Evidence

- [high] assertion_result: Final URL should contain /success
- [high] assertion_result: Visible text should include Refund request submitted
- [high] assertion_result: Agent exited with 1
- [high] assertion_result: Final URL should contain /success
- [high] assertion_result: Visible text should include Refund request submitted
- [high] assertion_result: Agent exited with 1
- [high] assertion_result: Final URL should contain /success
- [high] assertion_result: Visible text should include Refund request submitted
- [high] assertion_result: Agent did not appear to connect to the provided CDP browser
- [high] assertion_result: Final URL should contain /success
- [high] assertion_result: Visible text should include Refund request submitted
- [high] assertion_result: Agent exited with 1
- [high] assertion_result: Visible text should include Refund request submitted
- [high] assertion_result: No console errors should be recorded

## Standards Mapping

- AIUC-1 agent security, safety, and reliability: AgentCert evidence can support preparation for independent AIUC-1-style reviews; it is not an official certification.
- NIST AI Agent Standards Initiative: AgentCert evidence aligns with secure, interoperable, auditable agent deployment goals.
- OWASP Agentic AI threats and mitigations: AgentCert scenarios cover prompt injection, tool misuse, excessive agency, and runtime action governance.

## Artifacts

- tripwire-ci.result: `packages/tripwire-ci/.tripwire/public-demo/tripwire-result.json`
- tripwire-ci.outDir: `C:\Users\Gzw19\Documents\MCP Bench\packages\tripwire-ci\.tripwire\public-demo`
