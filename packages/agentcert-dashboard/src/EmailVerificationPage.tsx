import { useEffect, useState } from "react";

import { BrandMark, ProductHeader } from "./Brand";

export type EmailVerificationStatus = "verified" | "already_verified" | "expired" | "invalid";

export interface EmailVerificationState {
  status: EmailVerificationStatus;
  autoReturn: boolean;
  eyebrow: string;
  title: string;
  message: string;
}

const states: Record<EmailVerificationStatus, EmailVerificationState> = {
  verified: {
    status: "verified",
    autoReturn: true,
    eyebrow: "Email verified",
    title: "Alert delivery is ready.",
    message: "AgentCert can now send the alert types selected for this project to the verified address.",
  },
  already_verified: {
    status: "already_verified",
    autoReturn: true,
    eyebrow: "Already verified",
    title: "This address is already active.",
    message: "No changes were needed. The existing notification destination remains active.",
  },
  expired: {
    status: "expired",
    autoReturn: false,
    eyebrow: "Link expired",
    title: "Request a new verification email.",
    message: "Verification links expire after 24 hours. Return to Email alerts in the Workspace and send a new link.",
  },
  invalid: {
    status: "invalid",
    autoReturn: false,
    eyebrow: "Link unavailable",
    title: "This verification link is not valid.",
    message: "The link may be incomplete, disabled, or from an older verification request. Use the newest email or request another one.",
  },
};

export function resolveEmailVerificationState(search: string): EmailVerificationState {
  const status = new URLSearchParams(search).get("status") as EmailVerificationStatus | null;
  return status && status in states ? states[status] : states.invalid;
}

export default function EmailVerificationPage() {
  const state = resolveEmailVerificationState(window.location.search);
  const [seconds, setSeconds] = useState(5);

  useEffect(() => {
    document.title = `${state.eyebrow} | AgentCert`;
    if (!state.autoReturn) return;
    const interval = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1_000);
    const redirect = window.setTimeout(() => window.location.assign("/app"), 5_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(redirect);
    };
  }, [state.autoReturn, state.eyebrow]);

  const successful = state.status === "verified" || state.status === "already_verified";
  return (
    <div className="verification-surface">
      <ProductHeader />
      <main className="verification-page">
        <section className={`verification-result ${successful ? "success" : "attention"}`} aria-live="polite">
          <div className="verification-symbol"><BrandMark /></div>
          <span className="surface-mode">{state.eyebrow}</span>
          <h1>{state.title}</h1>
          <p>{state.message}</p>
          <div className="verification-actions">
            <a className="product-button primary" href="/app">{successful ? "Open Workspace" : "Manage email alerts"}</a>
          </div>
          {state.autoReturn ? <small>Returning to your Workspace in {seconds} seconds.</small> : null}
        </section>
        <aside className="verification-context">
          <span className="product-eyebrow"><span />Notification security</span>
          <h2>Only verified recipients receive operational alerts.</h2>
          <p>AgentCert stores a one-way token hash, never exposes the token in the Workspace, and records each queued delivery and provider outcome.</p>
          <dl>
            <div><dt>Verification</dt><dd>Recipient-owned link</dd></div>
            <div><dt>Delivery</dt><dd>Persistent queue and retry</dd></div>
            <div><dt>Audit</dt><dd>Job and delivery ledger</dd></div>
          </dl>
        </aside>
      </main>
    </div>
  );
}
