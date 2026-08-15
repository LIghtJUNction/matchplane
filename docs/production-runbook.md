# Production runbook

This runbook is for a single Ubuntu host installation. It keeps the payment service and the
federation workers on private listeners; Nginx is the only public HTTP entry point. The bundled
`configure-ubuntu-host.sh` script is a **test-only** bootstrap and must not be used for a production
tenant.

## 1. Prepare the host

Install PostgreSQL with TimescaleDB and pgvector, Valkey with TLS enabled, Nginx, `curl`, `openssl`,
and the release package. Create the `matchplane` system user/group and install the systemd units
from `packaging/systemd/`. Keep `/etc/matchplane/matchplane.env` and `/etc/matchplane/secrets/`
owned by `root:matchplane`; secret files should be mode `0640`.

The packaged production template is [packaging/config/matchplane.env](../packaging/config/matchplane.env).
Replace every placeholder before enabling a service. In particular, use a unique node UUID,
non-development database and Valkey credentials, three TLS files (server certificate, private key,
and client CA), and a platform-owned HTTPS payment callback origin.

## 2. Install the event broker

For a single host, install the pinned KRaft profile as root from the repository checkout:

```sh
sudo bash deploy/scripts/install-kafka.sh
systemctl is-active kafka
```

The script verifies the Apache Kafka archive checksum, creates a dedicated `kafka` user, binds the
broker and controller to loopback, disables automatic topic creation, and creates the five
MatchPlane topics with twelve partitions. It is intentionally a single-node profile; use a
multi-broker Kafka deployment before adding a second production node or accepting a loss of broker
redundancy.

## 3. Register the production federation node

Production services never auto-register their node identity. Before starting MatchPlane, insert
the operator-managed node row after migrations have created the schema:

```sql
INSERT INTO federation_nodes
  (id, name, grpc_endpoint, signing_key, certificate_fingerprint,
   protocol_major, protocol_minor, status)
VALUES
  ('REPLACE_WITH_NODE_UUID',
   'REPLACE_WITH_UNIQUE_NODE_NAME',
   'https://REACHABLE_HOSTNAME:50051',
   'REPLACE_WITH_OPERATOR_MANAGED_SIGNING_KEY_REFERENCE',
   'REPLACE_WITH_SHA256_CLIENT_CERTIFICATE_FINGERPRINT',
   1, 0, 'active');
```

The `id` must exactly match `MATCHPLANE_NODE_ID`, and the row must remain `active`. Keep the
signing key and certificate private material outside PostgreSQL when the deployment uses an
external secret manager; the database value is the federation identity/reference expected by the
current protocol. Set `MATCHPLANE_GRPC_ADDR` to the local listen address and put the externally
reachable endpoint in this registration row. Do not use `0.0.0.0` as the advertised endpoint.

## 4. Migrate and start the services

Run the one-shot initializer once for the release, then enable all runtime units together:

```sh
systemctl start matchplane-initialize.service
systemctl enable --now \
  matchplane-gateway.service matchplane-payment-service.service \
  matchplane-event-relay.service matchplane-matcher.service \
  matchplane-projector.service matchplane-vector-worker.service \
  matchplane-federation-hub.service
```

The gateway listens on `127.0.0.1:8080`, payment on `127.0.0.1:8081`, and federation gRPC on the
configured address. Keep Kafka, PostgreSQL, Valkey, and the payment API off the public interface.
Expose only the Nginx routes in [deploy/nginx/matchplane.conf](../deploy/nginx/matchplane.conf).

## 5. Verify before opening traffic

Run health probes and inspect the worker consumer groups:

```sh
curl --fail https://PUBLIC_ORIGIN/api/health/ready
curl --fail http://127.0.0.1:8081/health/ready
systemctl --no-pager --plain --full status \
  matchplane-gateway matchplane-payment-service matchplane-event-relay \
  matchplane-matcher matchplane-projector matchplane-vector-worker \
  matchplane-federation-hub kafka
journalctl -u matchplane-matcher -u matchplane-projector --since '-10 min' --no-pager
```

Then execute one authenticated marketplace introduction in a staging/test tenant and one payment
provider sandbox transaction. Confirm the contact audit, outbox/event relay, matcher trade, Valkey
projection, payment webhook/reconciliation, invoice, and refund records before enabling production
provider routes.

## 6. Safe updates and rollback

Before each update, record the running release and take both an encrypted PostgreSQL backup and a
copy of the current binaries, web release, Nginx configuration, and secret references. Verify the
dump with `pg_restore --list` (or the equivalent PostgreSQL tool) and copy a second backup to a
separate host. Keep a release-scoped, one-shot rollback timer armed for at least ten minutes while
the health and authenticated business probes run. Cancel it only after an operator confirms the
release; otherwise let it restore the previous application release and configuration.

Never overwrite the active release in place. Stage a versioned directory, verify checksums, switch
the `current` symlink atomically, reload Nginx only after `nginx -t`, and retain the previous
release until the rollback window has ended.

## 7. Payment and domain gates

Production mode must use real gateway configurations with immutable credential digests. Configure
EPay, Waffo Pancake, WeChat Pay, Alipay, and any custom adapter through the payment administrator
API; keep credentials in restricted files or an approved secret manager. Use test mode until
merchant onboarding, callback signature verification, invoice provider configuration, and a
successful sandbox refund are complete.

Do not request the `matx.tech` certificate until DNS has an `A` record for the host and (if used) a
`www` CNAME. After propagation, run `nginx -t`, request the certificate with Certbot, and switch
the Nginx `server_name` from the temporary IP certificate to `matx.tech`.
