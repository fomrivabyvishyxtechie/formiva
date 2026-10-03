# Formiva Security Boundary — Demo Track

## Non-negotiable rules

- Use synthetic or redacted data only.
- Never use real ID numbers, customer documents, production dumps, credentials, API keys, tokens, private keys, or SSH keys.
- Aadhaar-style, PAN-style, bank, and other identity fixtures must be visibly synthetic and invalid.
- Secrets belong only in approved local secret handling; never commit them, log them, or paste them into an AI coding tool.
- AI output is untrusted data; it must never directly authorize an action.
- Sensitive or irreversible actions require human/deterministic authorization.
- Do not claim compliance, production readiness, authenticity verification, or customer validation from the demo.
- Keep the AI Engine isolated and without cloud credentials when infrastructure work begins.

## Required checks before the first code merge

- Secret scan and `.gitignore` coverage.
- Synthetic fixture validator.
- Tenant-isolation test plan placeholder.
- Test proving malformed/timeout AI output cannot become approval.
- Evidence saved under `docs/evidence/phase-0/`.
