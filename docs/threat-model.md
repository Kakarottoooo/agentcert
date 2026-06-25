# Threat Model

MCPBench tests how tool-call sequences behave under benign synthetic conditions.

It tests:

- Sensitive synthetic canary flow from source tools into public or external sinks.
- Untrusted tool output preceding privileged calls.
- Retry loops and unsafe recovery patterns.
- Tool schema ambiguity that can degrade agent reliability.

It does not test:

- Real exploit payloads.
- Real credential theft.
- Production system compromise.
- Model jailbreak success rates against live providers by default.
- Complete security certification.

Untrusted-output tests use markers such as `BENIGN_EVAL_MARKER_UNTRUSTED_CONTENT`. Sensitive fixtures use markers such as `BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY`. These are local defensive markers, not real secrets.

