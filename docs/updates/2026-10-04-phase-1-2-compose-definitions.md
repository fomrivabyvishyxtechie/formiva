# Update: Phase 1.2 VM Compose Definitions - Security Corrected
Date: 2026-10-04

## Summary
Applied security-focused corrections to VM1 and VM2 Docker Compose definitions:
- Removed runtime fallback values for all secrets (DB_PASSWORD, AI_HMAC_SECRET) using :? syntax to fail closed when missing.
- Kept non-secret variables with safe defaults only where appropriate (DB_NAME, DB_USER for service convenience, but still required in db service).
- Verified healthcheck commands are supported by container images.
- Confirmed no public exposure of PostgreSQL (5432), AI Engine (8000), or SSH (22) ports.
- Confirmed VM2 has no cloud credentials and unrestricted outbound access (internal network).
- Preserved resource limits, log rotation (10m size, 3 files), and non-root users.

## Why
Required to meet Phase 1.2 security requirements: fail-closed secrets, no public sensitive ports, network isolation, and least-privilege containment.

## Files changed
- `infra/vm1/docker-compose.yml`
- `infra/vm1/.env.example` (unchanged, contains placeholders only)
- `infra/vm2/docker-compose.yml`
- `infra/vm2/.env.example` (unchanged, contains placeholders only)
- `apps/api/Dockerfile` (added curl for healthcheck)
- `apps/worker/Dockerfile` (unchanged)
- `services/ai-engine/Dockerfile` (unchanged)

## Tests/checks
- `docker compose config` validates syntax (warnings about unset variables are expected when checking without .env).
- No public ports exposed in compose output (API bound to 127.0.0.1:3000 only).
- VM2 network marked `internal: true`.
- Healthchecks use commands present in respective images (pg_isready, curl, clamdscan).
- Non-root users: `node` (API/worker), `nobody` (metrics), `1000:1000` (AI Engine).

## Security considerations
- **Secrets:** DB_PASSWORD, AI_HMAC_SECRET now required; missing values prevent container startup.
- **Network:** API bound to localhost only; VM2 isolated with `internal: true` network.
- **Ports:** No exposure of 5432, 8000, or 22 to host interfaces.
- **Least Privilege:** Containers run as non-root where possible.
- **Resource Limits:** CPU/memory caps prevent DoS.
- **Log Rotation:** Configured to prevent disk exhaustion.

## Remaining risks/follow-ups
- Backup service remains a placeholder; actual implementation requires storage integration.
- Healthcheck for ClamAV assumes `clamdscan` is present; may need adjustment if base image changes.
- When actual .env files are created, they must omit secrets or use vault/injected values (not committed).

## Next recommended task
**Phase 1.3: Host hardening.** Implement `infra/scripts/harden-oracle-linux9.sh` to secure the OCI VM environments.