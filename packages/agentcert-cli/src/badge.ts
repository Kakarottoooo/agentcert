import type { AgentCertBundle } from "./types.js";

export function renderAgentCertBadge(bundle: AgentCertBundle): string {
  const status = bundle.verdict.passed ? "pass" : "fail";
  const color = bundle.verdict.passed ? "#087f5b" : "#cc2431";
  const value = `${status} ${bundle.verdict.score}`;
  const valueWidth = Math.max(54, value.length * 7 + 18);
  const labelWidth = 76;
  const width = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="agentcert: ${escapeXml(value)}">
  <title>agentcert: ${escapeXml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".12"/>
    <stop offset="1" stop-color="#000" stop-opacity=".12"/>
  </linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#07172f"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">agentcert</text>
    <text x="${labelWidth / 2}" y="14">agentcert</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
