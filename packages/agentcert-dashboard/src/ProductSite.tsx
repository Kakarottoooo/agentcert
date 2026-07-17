import { useEffect, type ReactNode } from "react";
import { GITHUB_URL, NPM_URL, ProductFooter, ProductHeader } from "./Brand";

const STRIPE_EVIDENCE_URL = "https://kakarottoooo.github.io/agentcert/public-demo/vendor-sandbox-acceptance/";

export function LandingPage() {
  useProductMetadata(
    "AgentCert | Independent Assurance for AI Agents",
    "Test agents before release, gate high-risk actions at runtime, verify observed outcomes, and preserve portable evidence.",
    "/",
  );

  return (
    <div className="product-site">
      <ProductHeader active="product" />
      <main>
        <section className="product-hero" aria-labelledby="product-headline">
          <div className="product-hero-copy">
            <p className="product-eyebrow"><span /> Independent agent assurance</p>
            <h1 id="product-headline">Evidence for agents that take real actions.</h1>
            <p className="product-lede">
              Test before release. Gate high-risk actions at runtime. Verify observed outcomes.
              Preserve an audit-ready record of what happened.
            </p>
            <div className="product-hero-actions">
              <a className="product-button primary" href="/app?mode=signup">Start free</a>
              <a className="product-button secondary" href="/evidence">Explore public evidence</a>
            </div>
            <p className="product-hero-note">Open source CLI. Hosted beta. No credit card required.</p>
          </div>
          <AssuranceConsole />
        </section>

        <section className="product-proof-bar" aria-label="AgentCert product facts">
          <ProductFact value="3" label="lifecycle assurance layers" />
          <ProductFact value="10" label="release-gate controls" />
          <ProductFact value="v0.1" label="portable evidence schema" />
          <ProductFact value="90 days" label="hosted evidence retention" />
        </section>

        <section className="product-section lifecycle-section" id="product">
          <SectionHeading
            eyebrow="One assurance system"
            title="Before release, during execution, and after the fact."
            body="AgentCert keeps testing, runtime decisions, and evidence in one lifecycle instead of splitting them across disconnected dashboards."
          />
          <div className="lifecycle-lines">
            <LifecycleLine
              index="01"
              phase="Before release"
              title="MCPBench"
              body="Check MCP servers and agent-exposed tools for reliable behavior, policy violations, and observable failure paths."
              detail="Tools, MCP servers, policy traces"
            />
            <LifecycleLine
              index="02"
              phase="Before release"
              title="Tripwire CI"
              body="Run browser and computer-use agents against deterministic UI drift, prompt injection, network faults, and misleading state."
              detail="Browser agents, CI gates, regression evidence"
            />
            <LifecycleLine
              index="03"
              phase="At runtime"
              title="Onegent Runtime"
              body="Assess risk, apply policy, request approval, execute through a bounded adapter, verify the outcome, and write the audit packet."
              detail="High-risk actions, approval, verification"
            />
          </div>
        </section>

        <section className="product-section workflow-section">
          <div className="workflow-copy">
            <p className="product-eyebrow">From intent to evidence</p>
            <h2>Do not trust the agent's success message.</h2>
            <p>
              AgentCert compares proposed intent, policy decisions, tool activity, and observed system state.
              A run can only claim success when the evidence supports it.
            </p>
            <ol className="workflow-steps">
              <li><span>01</span><div><strong>Capture</strong><small>Normalize the event or proposed action.</small></div></li>
              <li><span>02</span><div><strong>Decide</strong><small>Evaluate risk, policy, and required approval.</small></div></li>
              <li><span>03</span><div><strong>Verify</strong><small>Compare expected and observed outcome.</small></div></li>
              <li><span>04</span><div><strong>Prove</strong><small>Retain signed, versioned, portable evidence.</small></div></li>
            </ol>
          </div>
          <div className="evidence-code" aria-label="Example AgentCert assurance event">
            <div className="evidence-code-header"><span>agentcert.evidence.v0.1</span><span className="verified-dot">verified</span></div>
            <pre>{`{
  "agent": "procurement-agent",
  "action": "SUBMIT",
  "risk": "HIGH",
  "policy": "human_approval_required",
  "approval": "approved",
  "expectedState": "SUBMITTED",
  "observedState": "SUBMITTED",
  "verification": "passed",
  "evidenceIntegrity": "complete"
}`}</pre>
            <div className="evidence-code-footer"><span>SHA-256 manifest reconciled</span><span>audit packet ready</span></div>
          </div>
        </section>

        <section className="product-section public-evidence-section" id="evidence">
          <SectionHeading
            eyebrow="Inspect the proof"
            title="Public evidence, not a product claim."
            body="Every published result keeps the test boundary, observed behavior, provenance, limitations, and artifacts available for inspection."
          />
          <div className="acceptance-record">
            <div className="acceptance-status"><span /> Passing</div>
            <div><small>Boundary</small><strong>Stripe sandbox, read only</strong></div>
            <div><small>Protected runs</small><strong>2 / 2 passed</strong></div>
            <div><small>Secret findings</small><strong>0 after two scans</strong></div>
            <div><small>Evidence</small><strong>Policy + report SHA-256</strong></div>
            <a href={STRIPE_EVIDENCE_URL} target="_blank" rel="noreferrer">Inspect record</a>
          </div>
          <p className="evidence-disclaimer">
            This proves the declared sandbox workflow produced the recorded result under the stated controls.
            It does not certify vendor-side systems or guarantee that an agent cannot fail.
          </p>
        </section>

        <section className="product-section agent-types-section">
          <SectionHeading
            eyebrow="Framework neutral"
            title="One evidence contract across different agents."
            body="Use a reference adapter or emit the universal event/action envelope directly. Human operators use the workspace; agents use CLI, API, SDK, or MCP."
          />
          <div className="agent-type-list" aria-label="Supported agent integration patterns">
            {[
              ["Browser", "Fault injection, screenshots, DOM, traces"],
              ["Coding", "Tool calls, repository changes, release gates"],
              ["MCP", "Server behavior, policy, canary exfiltration"],
              ["Workflow", "State transitions, approvals, outcomes"],
              ["Data", "Queries, provenance, bounded writes"],
            ].map(([name, detail]) => <div key={name}><strong>{name}</strong><span>{detail}</span></div>)}
          </div>
        </section>

        <section className="product-cta">
          <div>
            <p className="product-eyebrow">Five-minute path</p>
            <h2>Generate your first evidence bundle.</h2>
            <p>Start locally, keep the artifacts, and connect the hosted workspace only when your team needs shared review and history.</p>
          </div>
          <div className="quickstart-command"><code>npx agentcert init --template browser</code></div>
          <div className="product-hero-actions">
            <a className="product-button primary" href="/app?mode=signup">Create workspace</a>
            <a className="product-button dark" href={`${GITHUB_URL}#5-minute-quickstart`} target="_blank" rel="noreferrer">Read quickstart</a>
          </div>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}

export function PricingPage() {
  useProductMetadata(
    "Plans | AgentCert",
    "Start with the open-source AgentCert CLI or use the hosted beta for shared evidence review and runtime operations.",
    "/pricing",
  );
  return (
    <div className="product-site subpage-site">
      <ProductHeader active="pricing" />
      <main>
        <section className="subpage-hero">
          <p className="product-eyebrow">Plans</p>
          <h1>Start with evidence. Add operations when you need them.</h1>
          <p>AgentCert is in public beta. Current plans are intentionally simple and the limits below are the limits the product actually enforces.</p>
        </section>
        <section className="plans-grid" aria-label="AgentCert plans">
          <Plan
            name="Open source"
            price="$0"
            cadence="forever"
            description="For individual developers and public repositories."
            items={["CLI and GitHub Action", "JUnit, HTML, badge, and evidence bundle", "Evidence schema and validator", "Local corpus and reviewed dataset"]}
            action={<a className="product-button secondary" href={NPM_URL} target="_blank" rel="noreferrer">Install from npm</a>}
          />
          <Plan
            name="Hosted beta"
            price="$0"
            cadence="during beta"
            description="For teams that need shared history and review."
            items={["100 MiB per run", "1 GiB per project", "90-day evidence retention", "Projects, API keys, incidents, and approvals"]}
            action={<a className="product-button primary" href="/app?mode=signup">Start hosted beta</a>}
            featured
          />
          <Plan
            name="Design partner"
            price="Private pilot"
            cadence="scoped together"
            description="For one consequential workflow with a real owner."
            items={["Private assurance case", "Sandbox workflow integration", "Failure review and remediation evidence", "No publication without written approval"]}
            action={<a className="product-button secondary" href="mailto:ziweiguo666@gmail.com?subject=AgentCert%20design%20partner">Discuss a pilot</a>}
          />
        </section>
        <section className="pricing-boundary">
          <strong>Enterprise availability</strong>
          <p>Custom retention, legal hold, policy packs, and support are evaluated with design partners. AgentCert does not claim an enterprise SLA or compliance certification during beta.</p>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}

export function SecurityPage() {
  useProductMetadata(
    "Security and Trust | AgentCert",
    "AgentCert security boundaries, evidence integrity controls, retention policy, and responsible disclosure path.",
    "/security",
  );
  return (
    <div className="product-site subpage-site">
      <ProductHeader active="security" />
      <main>
        <section className="subpage-hero security-hero">
          <p className="product-eyebrow">Security and trust</p>
          <h1>Assurance must state its own limits.</h1>
          <p>AgentCert is designed to preserve independent evidence and reduce unsafe execution. It does not turn a test result into a guarantee.</p>
        </section>
        <section className="security-columns">
          <SecurityColumn title="Evidence integrity" items={["Canonical JSON and SHA-256 artifact manifests", "Server-signed evidence with historical key verification", "Complete, partial, and rejected integrity states", "Immutable deletion and lifecycle records"]} />
          <SecurityColumn title="Execution boundaries" items={["Project-scoped API keys", "Runtime approval separated from agent credentials", "Idempotency keys, shared rate limits, and bounded adapters", "Synthetic and vendor test-mode systems only by default"]} />
          <SecurityColumn title="Data handling" items={["Kind and MIME allowlists", "Per-run and per-project storage quotas", "90-day default retention", "Reviewed legal hold for approved enterprise cases"]} />
        </section>
        <section className="trust-boundary-grid">
          <div><h2>What AgentCert can prove</h2><p>That declared evidence was captured, validated, and retained for a specific run under stated controls, including the difference between intended and observed outcomes.</p></div>
          <div><h2>What it cannot prove</h2><p>That an agent will never fail, that undeclared systems were safe, or that a vendor's internal controls meet a compliance standard.</p></div>
        </section>
        <section className="responsible-disclosure">
          <div><p className="product-eyebrow">Responsible disclosure</p><h2>Found a security issue?</h2><p>Do not open a public issue with sensitive details. Follow the repository security policy for private reporting and response expectations.</p></div>
          <a className="product-button dark" href={`${GITHUB_URL}/security/policy`} target="_blank" rel="noreferrer">View security policy</a>
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}

function AssuranceConsole() {
  return (
    <div className="assurance-console" aria-label="AgentCert assurance record preview">
      <div className="console-topbar"><span><i /> Live assurance record</span><small>run_8f29c</small></div>
      <div className="console-summary">
        <div><small>Release decision</small><strong>Approval required</strong></div>
        <span className="risk-badge">HIGH RISK</span>
      </div>
      <div className="console-action"><small>PROPOSED ACTION</small><strong>Submit purchase order</strong><span>$4,850.00 to Acme Industrial Supply</span></div>
      <div className="console-timeline">
        <ConsoleEvent status="done" label="Intent captured" value="SUBMIT" />
        <ConsoleEvent status="done" label="Policy evaluated" value="PO over $1,000" />
        <ConsoleEvent status="done" label="Human approval" value="Approved by reviewer" />
        <ConsoleEvent status="done" label="Observed outcome" value="DRAFT -> SUBMITTED" />
        <ConsoleEvent status="done" label="Evidence integrity" value="Complete" />
      </div>
      <div className="console-footer"><span>Expected = observed</span><strong>Verification passed</strong></div>
    </div>
  );
}

function ConsoleEvent({ status, label, value }: { status: "done"; label: string; value: string }) {
  return <div className={`console-event ${status}`}><span className="event-check">&#10003;</span><div><strong>{label}</strong><small>{value}</small></div></div>;
}

function ProductFact({ value, label }: { value: string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <div className="section-heading"><p className="product-eyebrow">{eyebrow}</p><h2>{title}</h2><p>{body}</p></div>;
}

function LifecycleLine({ index, phase, title, body, detail }: { index: string; phase: string; title: string; body: string; detail: string }) {
  return <article><span className="lifecycle-index">{index}</span><p>{phase}</p><h3>{title}</h3><div className="lifecycle-swatch" /><p className="lifecycle-body">{body}</p><small>{detail}</small></article>;
}

function Plan({ name, price, cadence, description, items, action, featured = false }: { name: string; price: string; cadence: string; description: string; items: string[]; action: ReactNode; featured?: boolean }) {
  return <article className={`plan ${featured ? "featured" : ""}`}>{featured ? <span className="plan-label">Current beta</span> : null}<h2>{name}</h2><div className="plan-price"><strong>{price}</strong><span>{cadence}</span></div><p>{description}</p><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>{action}</article>;
}

function SecurityColumn({ title, items }: { title: string; items: string[] }) {
  return <article><h2>{title}</h2><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></article>;
}

function useProductMetadata(title: string, description: string, path: string) {
  useEffect(() => {
    document.title = title;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", description);
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", title);
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.setAttribute("content", description);
    document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", `${window.location.origin}${path}`);
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", `${window.location.origin}${path}`);
    document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.setAttribute("content", "index,follow");
  }, [description, path, title]);
}
