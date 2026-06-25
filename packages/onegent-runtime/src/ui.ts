import type { MockPurchaseOrder, ProcurementWalkthroughState } from "./types.js";

export function renderProcurementWalkthroughHtml(state: ProcurementWalkthroughState): string {
  const review = state.review;
  const approvalStatus = review.approvalRequest?.status ?? "not required";
  const verificationStatus = review.verificationResult?.success === true ? "passed" : "pending";

  return page(
    "Procurement Action Gateway Walkthrough",
    `
      <main>
        <section class="hero">
          <p class="eyebrow">AgentCert Onegent Runtime</p>
          <h1>Procurement approval boundary</h1>
          <p>
            ProcurementAgent wants to submit a ${money(state.purchaseOrder.amount, state.purchaseOrder.currency)}
            purchase order to ${escapeHtml(state.purchaseOrder.vendor)}. The gateway captures the intent,
            requires human approval, performs local mock ERP execution, verifies state, and emits an audit packet.
          </p>
        </section>

        <section class="grid">
          <article>
            <h2>Action</h2>
            <dl>
              <dt>Type</dt><dd>${review.action.actionType}</dd>
              <dt>Status</dt><dd>${review.action.status}</dd>
              <dt>Target</dt><dd>${escapeHtml(review.action.targetSystem)}</dd>
              <dt>Business object</dt><dd>${escapeHtml(review.action.businessObjectId)}</dd>
            </dl>
          </article>

          <article>
            <h2>Risk and policy</h2>
            <dl>
              <dt>Risk</dt><dd>${review.riskAssessment.riskLevel} (${review.riskAssessment.riskScore})</dd>
              <dt>Approval</dt><dd>${approvalStatus}</dd>
              <dt>Reason</dt><dd>${escapeHtml(review.riskAssessment.reasons.join(" "))}</dd>
            </dl>
          </article>

          <article>
            <h2>Mock ERP</h2>
            <dl>
              <dt>PO</dt><dd>${escapeHtml(state.purchaseOrder.id)}</dd>
              <dt>Vendor</dt><dd>${escapeHtml(state.purchaseOrder.vendor)}</dd>
              <dt>Status</dt><dd>${state.purchaseOrder.status}</dd>
              <dt>Verification</dt><dd>${verificationStatus}</dd>
            </dl>
          </article>
        </section>

        <section>
          <h2>Audit trail</h2>
          <ol class="timeline">
            ${review.auditEvents
              .map(
                (event) => `
                  <li>
                    <strong>${event.eventType}</strong>
                    <span>${escapeHtml(event.message)}</span>
                  </li>
                `,
              )
              .join("")}
          </ol>
        </section>
      </main>
    `,
  );
}

export function renderPurchaseOrderHtml(purchaseOrder: MockPurchaseOrder): string {
  return page(
    `Mock ERP ${purchaseOrder.id}`,
    `
      <main>
        <section class="hero">
          <p class="eyebrow">Local mock procurement system</p>
          <h1>${escapeHtml(purchaseOrder.id)}</h1>
          <p>This page is a local-only mock ERP view. It is not connected to a vendor portal or payment system.</p>
        </section>
        <section class="grid">
          <article>
            <h2>Purchase order</h2>
            <dl>
              <dt>Vendor</dt><dd>${escapeHtml(purchaseOrder.vendor)}</dd>
              <dt>Amount</dt><dd>${money(purchaseOrder.amount, purchaseOrder.currency)}</dd>
              <dt>Status</dt><dd>${purchaseOrder.status}</dd>
              <dt>Line item</dt><dd>${escapeHtml(purchaseOrder.lineItem)}</dd>
            </dl>
          </article>
        </section>
      </main>
    `,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --text: #172033;
        --muted: #586174;
        --border: #d8dde6;
        --accent: #0f766e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(1120px, calc(100% - 32px)); margin: 32px auto; }
      .hero { margin-bottom: 24px; }
      .eyebrow { color: var(--accent); font-size: 13px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
      h1 { margin: 8px 0 12px; font-size: clamp(32px, 5vw, 56px); line-height: 1; letter-spacing: 0; }
      h2 { margin: 0 0 14px; font-size: 18px; }
      p { max-width: 760px; color: var(--muted); line-height: 1.6; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
      article, section:not(.hero) {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 18px;
      }
      dl { display: grid; grid-template-columns: 130px 1fr; gap: 10px 14px; margin: 0; }
      dt { color: var(--muted); }
      dd { margin: 0; font-weight: 650; overflow-wrap: anywhere; }
      .timeline { margin: 0; padding-left: 20px; }
      .timeline li { margin: 0 0 12px; }
      .timeline span { display: block; color: var(--muted); margin-top: 2px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
