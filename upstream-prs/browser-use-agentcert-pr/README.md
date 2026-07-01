# Upstream PR Plan: browser-use × AgentCert Tripwire

Goal: make browser-use's repo the first external consumer/pointer to AgentCert
evidence. Two options, in recommended order.

## Option A (recommended first): Community integrations listing

browser-use's `examples/integrations/README.md` explicitly asks third-party
products to be added to the "Community integrations" list instead of vendoring
code. This is a one-line PR with high merge probability.

Steps:

1. Fork `browser-use/browser-use`, branch `add-agentcert-community-listing`.
2. In `examples/integrations/README.md`, add under "Community integrations"
   (their required format):

```markdown
- [AgentCert Tripwire](https://github.com/Kakarottoooo/agentcert) - CI regression gate that runs a browser-use agent under injected web faults (popups, button drift, decoy buttons, prompt-injection banners, slow network, HTTP failures) and grades runs deterministically with screenshots, traces, and JUnit output. Maintained by @Kakarottoooo.
```

3. PR title: `docs: add AgentCert Tripwire to community integrations`
4. PR body: see `pr-body-option-a.md`.

## Option B (follow-up, only if maintainers are receptive): runnable example

A small `examples/integrations/agentcert-tripwire/` directory following their
checklist (uv setup, documented env vars, no secrets, run command from repo
root). Files are staged in `example/` next to this plan:

- `example/README.md`
- `example/agentcert_tripwire_agent.py`
- `example/tripwire.yml`
- `example/agentcert-tripwire.yml` (GitHub Actions workflow)

Suggested sequencing: open Option A, mention in the PR body that a runnable
example exists and offer to contribute it if wanted. Let the maintainers pull
Option B in, rather than pushing a large diff first.

## Evidence to cite in both PRs

- Real Agent Robustness Lab (browser-use currently leads at 8/9):
  https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/
- The adapter used for the published run:
  https://github.com/Kakarottoooo/agentcert/tree/main/examples/real-agents/browser-use

Framing rule: browser-use is presented positively (best score in the matrix).
The PR gives their users a way to keep it that way in their own CI.
