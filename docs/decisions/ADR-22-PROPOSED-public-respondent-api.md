# ADR-22: Public respondent API (drafts, tokens, consent)

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-25
Phase: 3 (Prompt 3.2)

## Decision
1. Respondent links are opaque: 32 random bytes as 64 hex characters. Only the SHA-256 digest is stored (`respondent_tokens.token_hash`), as for ADR-19 invitations. No signed or JWT token.
2. Unknown, malformed, expired, revoked and unpublished-version links all return the same `404` body.
3. One token = one respondent. The case is created lazily on the first `PUT .../draft`, with the token row locked (`FOR UPDATE`) so racing first saves create exactly one case.
4. `draft_revision` is `max(case_values.revision)` for the case. A save with a stale revision gets `409`. Each save writes the sent fields as revision N+1.
5. Consent is recorded before any value is written. `notice_version` must equal the version's `privacy_notice_version`. A form version without a notice cannot accept values (fail closed).
6. `consent_records.ip_hash` = HMAC-SHA256(`IP_HASH_SECRET`, IP). Without the secret the IP is not recorded.
7. `highly_sensitive` fields are refused with `422` until Prompt 3.5 adds encryption. File and signature fields are refused (upload flow, 3.3). 12-digit sequences in free-text fields are refused (Government Documents Policy).
8. `sensitive` and `highly_sensitive` answers are not returned by `GET` (same rule as browser drafts, ADR-21).
9. Rate limiting is an in-process fixed window (per IP 120/min, per token 60/min), `429` + `Retry-After`.
10. Request logs redact the token from the URL and carry no IP. Problem responses use the redacted URL.
11. `upload-requests` and `submit` exist and return `501` (Prompts 3.3 and 3.4).
12. No HTTP route issues links in 3.2. `issueRespondentToken()` is a service function; the staff route is a later prompt.

## Reasons
Schema already holds hash-only tokens and append-only consent. Opaque tokens can be revoked in the database and leak nothing if the database leaks.

## Consequences
- Rate limits are per API process (multiply with instances) and rely on `trustProxy`, so `X-Forwarded-For` must be set by a trusted proxy.
- Contract field names follow the 3.1a code (`field_key`, `field_type`, `slots`), not the older contract example (`key`, `type`, `document_slots`).
- The web page `/f/[token]` is not wired yet (3.2b), and CORS is undecided.
