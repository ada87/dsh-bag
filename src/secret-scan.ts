import { SyncError } from './errors.js'

/**
 * High-confidence secret scanner. Diagnostics name the path and rule only;
 * the matched value never appears in errors, logs, or API payloads.
 */
export interface Finding {
  rule: string
  path: string
}

const RULES: Array<{ id: string; re: RegExp }> = [
  { id: 'private-key-header', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'github-pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { id: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'stripe-live', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: 'dsh-door-token', re: /\bdsh[rh]_[A-Za-z0-9]{16,}\b/ },
  { id: 'bearer-header', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
]

export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = []
  for (const rule of RULES) {
    if (rule.re.test(text)) findings.push({ rule: rule.id, path })
  }
  return findings
}

export function formatFindings(findings: readonly Finding[]): string {
  const lines = findings.map(finding => `${finding.path} (${finding.rule})`)
  return `secret scan refused the payload: ${lines.join(', ')}`
}

export function assertClean(findings: readonly Finding[]): void {
  if (findings.length > 0) throw new SyncError('secret', formatFindings(findings))
}
