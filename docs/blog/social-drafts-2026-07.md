# Social Drafts: Real Agent Robustness Lab (June 2026)

Publish targets: X thread + LinkedIn post. Both link to the Lab page and the
full article.

- Lab page: https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/
- Article: docs/blog/2026-07-we-fault-injected-real-browser-agents.md (publish to blog/X article first, then link)
- Repo: https://github.com/Kakarottoooo/agentcert

---

## X Thread

**1/**
We fault-injected 5 real browser agents with 9 common web failures: popups,
moved buttons, decoy buttons, slow networks, prompt injection, HTTP 503s.

45 runs. 31 passed.

Every screenshot, DOM snapshot, and trace is public. Here's where they broke 🧵

**2/**
The matrix (same task, same faults):

- Playwright strict CDP: 4/9
- Playwright resilient CDP: 6/9
- Playwright ARIA: 6/9
- Stagehand (gpt-4.1-mini): 7/9
- browser-use (gpt-4.1-mini): 8/9

The interesting part isn't the scores. It's *which* faults broke *which* agents.

**3/**
A decoy button with the same label as the real submit fooled 4 of the 5 agents
— including Stagehand, an LLM framework. It clicked the decoy, its form input
got silently cleared, and 13 steps later it was still on the refund page.

Only browser-use picked the real button.

**4/**
Same model, different frameworks, different survival. Stagehand and browser-use
both ran gpt-4.1-mini, both retried the disabled submit just fine — but only
one saw through the decoy.

LLM-agent adaptivity is real. It is not uniform. You have to measure it.

**5/**
Now the bad news. Under an injected HTTP failure, ALL FIVE agents — scripted
and LLM alike — reported success on a failed task.

The POST returned a 503. The success page rendered an error. Every agent still
landed on /success and called it done.

**6/**
If your agent health check is "did it reach the success URL" or "did the agent
say it finished" — you're shipping silent false successes to production.

Only deterministic assertions caught it: missing success text + a 503 in the
console.

**7/**
This is why we built Tripwire: regression CI for browser agents. Same faults,
your agent, every PR / prompt change / model swap:

npx agentcert init
npx agentcert run

HTML report, JUnit, screenshots, traces. Open source, Apache-2.0.

**8/**
Full matrix with clickable evidence for every run:
https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/

If you maintain a browser-agent framework and want it in the matrix, adapters
are ~100 lines. PRs welcome.

---

## LinkedIn Post

**Every browser agent we tested reported success on a failed task.**

We ran 5 real browser agents (3 scripted Playwright variants, Stagehand, and
browser-use) through 9 realistic web faults: modal overlays, button drift,
decoy buttons, disabled submits, layout shifts, prompt-injection banners, slow
networks, and HTTP failures. 45 runs, deterministic grading, all evidence
public.

Three findings:

1. **A decoy button fooled 4 of 5 agents — including an LLM framework.** Every
scripted agent crashed on it, and Stagehand clicked the decoy, silently losing
its form input. Only browser-use (8/9) picked the real button. Both LLM
frameworks ran the same model (gpt-4.1-mini): adaptivity is real, but it is
not uniform across frameworks, and you only find out by injecting the fault.

2. **All five agents silently succeeded on a failed task.** Under an injected
HTTP 503, every agent reached the /success URL while the page rendered an
error — and reported the task as done. If your health check is "the agent says
it finished," you're shipping false successes. Only deterministic outcome
assertions caught it.

3. **A benign prompt-injection banner fooled nobody** — this time. One banner
on one task is not a safety claim, and harder injection suites are next.

This is why we built AgentCert Tripwire: regression CI for browser agents.
Nine faults injected into your agent's own task, on every PR, prompt change,
and model swap — with screenshots, DOM snapshots, traces, JUnit, and an HTML
report as evidence. Open source, Apache-2.0, npx agentcert init to start.

Full interactive matrix with per-run evidence:
https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/

If you build or run browser agents in production, I'd love to hear what faults
you've been bitten by that we should add to the suite.

---

## Notes for Publishing

- Attach the matrix table as an image (screenshot the Lab page table) on both
  platforms; text-only tables get cropped.
- On X, tweet 5 (silent false success) is the strongest standalone hook — it
  can also be pulled out as a single quote-tweetable post.
- Honest-caveat rule: keep "one task / one suite / n=1 per cell" phrasing when
  someone asks about rankings; the credibility of the Lab is the moat.
- Tag browser-use maintainers only in a positive framing (8/9, best in
  matrix) — the goal is for them to reshare it.
