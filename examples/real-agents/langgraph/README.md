# LangGraph Browser/Tool Agent Smoke

This adapter tests a public LangGraph integration path without requiring an
LLM key. The graph has one tool node that connects to Tripwire's controlled
Chromium instance through `TRIPWIRE_CDP_URL`, fills the local refund form, and
clicks a submit-like button.

It is a setup and evidence smoke, not a claim about all LangGraph agents.

## Install

```powershell
python -m venv .venv-langgraph
.\\.venv-langgraph\\Scripts\\python -m pip install --upgrade pip
.\\.venv-langgraph\\Scripts\\python -m pip install -r examples/real-agents/langgraph/requirements.txt
```

Keep the venv activated, then run from the repository root:

```powershell
npm run tripwire:lab-langgraph
```

Tripwire writes:

- `public-demo/real-agent-robustness/evidence/langgraph/tripwire-result.json`
- `public-demo/real-agent-robustness/evidence/langgraph/tripwire-report.html`
- screenshots, DOM snapshots, traces, and JUnit XML

## Why This Exists

External users often wrap browser actions in LangGraph nodes rather than using
a single browser-agent package. This smoke checks that AgentCert can observe
that style of tool graph through the same CDP and evidence path.
