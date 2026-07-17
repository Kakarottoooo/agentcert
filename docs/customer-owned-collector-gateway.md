# Customer-owned Remote Collector and Gateway v0.2

The customer-owned collector gateway runs beside an agent, not inside the
AgentCert hosted service. It owns the source signing key, local append-only
queue, and Hosted API credential. The agent receives only a local gateway
token.

## Trust boundary

```text
agent process
  | local authenticated event intent
  v
customer-owned gateway
  | fsync -> sequence -> hash link -> Ed25519 source signature
  | durable retry + signed heartbeat
  v
AgentCert hosted control plane
  | verify source key -> replay check -> reconcile receipt
  v
AgentCert server attestation
```

The source private key and `AGENTCERT_API_KEY` never appear in an event,
receipt, ACK, or gateway response. The hosted service stores only the public
source key and its SHA-256 fingerprint. Key rotation retires the previous key;
existing runs may finish and replay with their original key, but a retired key
cannot start a new run.

## Run the reference deployment

```bash
docker build -f packages/agentcert-sdk/Dockerfile.gateway -t agentcert-collector-gateway:v0.2 packages/agentcert-sdk
docker volume create agentcert-collector-data
docker run --rm -p 127.0.0.1:8787:8787 \
  -v agentcert-collector-data:/var/lib/agentcert \
  -e AGENTCERT_BASE_URL=https://agentcert.app \
  -e AGENTCERT_PROJECT_ID=your-project-id \
  -e AGENTCERT_API_KEY \
  -e AGENTCERT_GATEWAY_TOKEN \
  agentcert-collector-gateway:v0.2
```

Generate `AGENTCERT_GATEWAY_TOKEN` as at least 32 random bytes and store both
secrets in the container runtime's secret store. Do not pass them as command
line arguments. Keep `/var/lib/agentcert` on an encrypted persistent volume.
Create the project API key with only `runs:read`, `events:write`, and
`collector:manage`.

The local protocol is intentionally small:

```text
POST /v1/runs/{runId}/start
POST /v1/runs/{runId}/events
POST /v1/runs/{runId}/drops
POST /v1/runs/{runId}/complete
POST /v1/flush
GET  /healthz
```

Every mutating request requires `Authorization: Bearer $AGENTCERT_GATEWAY_TOKEN`.
Event requests require an idempotency key. Reusing the key with identical
content returns the original signed record; different content returns HTTP 409.

## Failure and recovery

- A local request succeeds only after the signed record is appended and
  `fsync`ed.
- Hosted delivery is at least once. The local ACK advances only after the
  server accepts the exact sequence and event hash.
- Network failures leave records pending. Startup discovers existing journals,
  replays them, and then retries receipt reconciliation.
- A known local loss is represented by `EVENTS_DROPPED` plus an explicit
  sequence gap. The server opens a deduplicated incident.
- Heartbeats report pending count and last ACK. A stale heartbeat is observable
  through `GET /v1/projects/{projectId}/collector-status`.

Run the black-box suite against any compatible gateway:

```bash
AGENTCERT_GATEWAY_URL=http://127.0.0.1:8787 \
AGENTCERT_GATEWAY_TOKEN=... \
npx agentcert-collector-conformance
```

## Evidence strength and non-claims

A source-signed gateway journal can support `recorded`: AgentCert can prove
which bytes the customer collector signed, their order, and whether the hosted
copy reconciles. It cannot prove that every real-world action passed through
the collector.

For `enforced`, keep target-system write credentials outside the agent and use
the Onegent controlled action adapter plus an immutable mandate. For
`outcome_verified`, use an independent read credential and outcome probe. A
network policy should prevent the agent container from reaching the target
write API directly. Hash linking detects mutation and omission in the collected
chain; it cannot detect an action performed entirely outside the gateway.

Protocol schema: `packages/agentcert-sdk/remote-collector.schema.json`.
