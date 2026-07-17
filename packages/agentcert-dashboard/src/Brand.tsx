import type { ReactNode } from "react";

export const GITHUB_URL = "https://github.com/Kakarottoooo/agentcert";
export const NPM_URL = "https://www.npmjs.com/package/agentcert";

export type ProductNavActive = "product" | "evidence" | "pricing" | "security";

export const PRODUCT_NAV_LINKS: ReadonlyArray<{
  id: ProductNavActive | "docs";
  label: string;
  href: string;
  external?: boolean;
}> = [
  { id: "product", label: "Product", href: "/#product" },
  { id: "evidence", label: "Evidence", href: "/evidence" },
  { id: "pricing", label: "Plans", href: "/pricing" },
  { id: "security", label: "Security", href: "/security" },
  { id: "docs", label: "Docs", href: `${GITHUB_URL}#5-minute-quickstart`, external: true },
];

export function BrandMark() {
  return (
    <span className="product-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 2.5 20 6v5.6c0 5.1-3.3 8.8-8 10-4.7-1.2-8-4.9-8-10V6l8-3.5Z" />
        <path d="m8.3 12 2.3 2.3 5.1-5.2" />
      </svg>
    </span>
  );
}

export function BrandLink({ href = "/", suffix }: { href?: string; suffix?: ReactNode }) {
  return (
    <a className="product-brand" href={href} aria-label={suffix ? `AgentCert ${String(suffix)}` : "AgentCert home"}>
      <BrandMark />
      <span className="product-brand-copy"><strong>AgentCert</strong>{suffix ? <small>{suffix}</small> : null}</span>
    </a>
  );
}

export function ProductHeader({ active }: { active?: ProductNavActive }) {
  return (
    <header className="product-nav">
      <BrandLink />
      <nav aria-label="Product navigation">
        {PRODUCT_NAV_LINKS.map((item) => (
          <a
            key={item.id}
            className={active === item.id ? "active" : ""}
            href={item.href}
            {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="product-nav-actions">
        <a href="/app">Sign in</a>
        <a className="product-button primary compact" href="/app?mode=signup">Start free</a>
      </div>
    </header>
  );
}

export function ProductFooter() {
  return (
    <footer className="product-footer">
      <div><BrandLink /><p>Independent assurance and evidence for agents that take real actions.</p></div>
      <div><strong>Product</strong><a href="/evidence">Public evidence</a><a href="/pricing">Plans</a><a href="/app">Workspace</a></div>
      <div><strong>Developers</strong><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a><a href={NPM_URL} target="_blank" rel="noreferrer">npm</a><a href={`${GITHUB_URL}/tree/main/docs`} target="_blank" rel="noreferrer">Documentation</a></div>
      <div><strong>Trust</strong><a href="/security">Security</a><a href={`${GITHUB_URL}/blob/main/docs/threat-model.md`} target="_blank" rel="noreferrer">Threat model</a><a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">Apache-2.0</a></div>
      <p className="product-copyright">AgentCert public beta. Assurance evidence is not a guarantee or an official certification.</p>
    </footer>
  );
}
