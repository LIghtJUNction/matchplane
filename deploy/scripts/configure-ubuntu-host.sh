#!/usr/bin/env bash
set -euo pipefail

# This bootstrap provisions the local test profile. Production mode must use the
# packaged production template and an explicit TLS/provider onboarding runbook.
if [[ ${MATCHPLANE_ENVIRONMENT:-test} != test ]]; then
  echo 'configure-ubuntu-host.sh only provisions the test environment' >&2
  exit 1
fi

if [[ $(id -u) -ne 0 ]]; then
  echo 'configure-ubuntu-host.sh must run as root' >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

node_id=${MATCHPLANE_NODE_ID:-}
if [[ -z $node_id ]]; then
  node_id=$(cat /proc/sys/kernel/random/uuid)
fi
if [[ ! $node_id =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo 'MATCHPLANE_NODE_ID must be a UUID' >&2
  exit 1
fi
if [[ $node_id == 00000000-0000-7000-8000-00000000000a ]]; then
  echo 'MATCHPLANE_NODE_ID must not use the development default' >&2
  exit 1
fi

# Prepare the local backup target, but never enable its timer from this test-only
# bootstrap. Production operators must opt in after running the first backup.
"$repository_root/packaging/scripts/postgres-backup-prepare.sh"

install -d -m 0750 -o root -g matchplane /etc/matchplane/secrets
install -d -m 0750 -o root -g matchplane-gateway /etc/matchplane/secrets/gateway
install -d -m 0750 -o root -g matchplane-payment /etc/matchplane/secrets/payment
install -d -m 0750 -o root -g matchplane-web /etc/matchplane/secrets/web
# Repair only the router-state root metadata; Web owns creation of pointers, generations, audit
# records, and credential slots below it, so bootstrap never truncates or replaces existing state.
install -d -m 0770 -o root -g matchplane-web /etc/matchplane/secrets/root-email
install -d -m 0750 -o root -g matchplane /etc/matchplane/services
install -d -m 0750 -o root -g root /etc/matchplane/recovery
install -d -m 0750 -o matchplane-web -g matchplane-web /var/lib/matchplane/subplatform-uploads

create_hex_secret() {
  local path=$1
  local byte_count=$2
  local group=$3
  if [[ ! -s $path ]]; then
    umask 0027
    openssl rand -hex "$byte_count" >"$path"
  fi
  chown "root:$group" "$path"
  chmod 0640 "$path"
}

create_hex_secret /etc/matchplane/secrets/database.password 24 root
create_hex_secret /etc/matchplane/recovery/database.password 24 root
create_hex_secret /etc/matchplane/secrets/gateway/contact-data.key 32 matchplane-gateway
create_hex_secret /etc/matchplane/secrets/payment/invoice-data.key 32 matchplane-payment
create_hex_secret /etc/matchplane/secrets/payment/payment-admin.token 32 matchplane-payment
create_hex_secret /etc/matchplane/secrets/gateway/gateway-admin.token 32 matchplane-gateway
# The Next.js BFF needs the same administrator bearers, but must not gain access to the payment
# invoice key or gateway contact-data key. Keep a dedicated web-readable copy of each token.
install -m 0640 -o root -g matchplane-web \
  /etc/matchplane/secrets/payment/payment-admin.token \
  /etc/matchplane/secrets/web/payment-admin.token
install -m 0640 -o root -g matchplane-web \
  /etc/matchplane/secrets/gateway/gateway-admin.token \
  /etc/matchplane/secrets/web/gateway-admin.token

database_password=$(tr -d '\r\n' </etc/matchplane/secrets/database.password)
recovery_database_password=$(tr -d '\r\n' </etc/matchplane/recovery/database.password)
if [[ ! $database_password =~ ^[0-9a-f]{48}$ ]]; then
  echo 'database password file is malformed' >&2
  exit 1
fi
if [[ ! $recovery_database_password =~ ^[0-9a-f]{48}$ ]]; then
  echo 'recovery database password file is malformed' >&2
  exit 1
fi

current_preload=$(sudo -u postgres psql -Atqc 'SHOW shared_preload_libraries' postgres)
case ",$current_preload," in
  *,timescaledb,*) ;;
  *)
    if [[ -n $current_preload ]]; then
      next_preload="$current_preload,timescaledb"
    else
      next_preload=timescaledb
    fi
    if [[ ! $next_preload =~ ^[a-zA-Z0-9_,[:space:]-]+$ ]]; then
      echo 'existing shared_preload_libraries value is unsafe to preserve' >&2
      exit 1
    fi
    printf "ALTER SYSTEM SET shared_preload_libraries = '%s';\n" "$next_preload" |
      sudo -u postgres psql --set=ON_ERROR_STOP=1 postgres
    systemctl restart postgresql
    ;;
esac

for _ in $(seq 1 30); do
  if pg_isready --quiet --host 127.0.0.1 --port 5432; then
    break
  fi
  sleep 1
done
pg_isready --quiet --host 127.0.0.1 --port 5432

if [[ $(sudo -u postgres psql -Atqc \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'matchplane'" postgres) == 0 ]]; then
  printf "CREATE ROLE matchplane LOGIN PASSWORD '%s';\n" "$database_password" |
    sudo -u postgres psql --set=ON_ERROR_STOP=1 postgres
else
  printf "ALTER ROLE matchplane LOGIN PASSWORD '%s';\n" "$database_password" |
    sudo -u postgres psql --set=ON_ERROR_STOP=1 postgres
fi

if [[ $(sudo -u postgres psql -Atqc \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'matchplane_recovery'" postgres) == 0 ]]; then
  printf "CREATE ROLE matchplane_recovery WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '%s';\n" \
    "$recovery_database_password" |
    sudo -u postgres psql --set=ON_ERROR_STOP=1 postgres
else
  printf "ALTER ROLE matchplane_recovery WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '%s';\n" \
    "$recovery_database_password" |
    sudo -u postgres psql --set=ON_ERROR_STOP=1 postgres
fi

if [[ $(sudo -u postgres psql -Atqc \
  "SELECT count(*) FROM pg_database WHERE datname = 'matchplane'" postgres) == 0 ]]; then
  sudo -u postgres createdb --owner=matchplane matchplane
fi

sudo -u postgres psql --set=ON_ERROR_STOP=1 \
  --command='CREATE EXTENSION IF NOT EXISTS timescaledb' matchplane
sudo -u postgres psql --set=ON_ERROR_STOP=1 \
  --command='CREATE EXTENSION IF NOT EXISTS vector' matchplane
sudo -u postgres psql --set=ON_ERROR_STOP=1 \
  --command="ALTER DATABASE matchplane SET timescaledb.telemetry_level = 'off'" matchplane

environment_file=$(mktemp /etc/matchplane/matchplane.env.XXXXXX)
trap 'rm -f "$environment_file"' EXIT
{
  printf '%s\n' 'MATCHPLANE_ENVIRONMENT=test'
  # Authentication bootstrap is an explicit operator choice; this test profile does not
  # fabricate tenants, domains, catalogues, or other marketplace data.
  printf '%s\n' 'MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=false'
  printf 'MATCHPLANE_NODE_ID=%s\n' "$node_id"
  printf '%s\n' 'MATCHPLANE_GRPC_ADDR=127.0.0.1:50051'
  printf '%s\n' 'MATCHPLANE_KAFKA_BROKERS=127.0.0.1:9092'
  printf '%s\n' 'MATCHPLANE_KAFKA_SECURITY_PROTOCOL=PLAINTEXT'
  printf '%s\n' 'MATCHPLANE_KAFKA_SSL_CA_LOCATION='
  printf '%s\n' 'MATCHPLANE_KAFKA_SSL_CERTIFICATE_LOCATION='
  printf '%s\n' 'MATCHPLANE_KAFKA_SSL_KEY_LOCATION='
  printf '%s\n' 'MATCHPLANE_LOG_FILTER=info,matchplane=info'
  printf '%s\n' 'MATCHPLANE_OTLP_ENDPOINT=http://127.0.0.1:4317'
  printf '%s\n' 'MATCHPLANE_REQUIRE_TLS=false'
  printf '%s\n' 'MATCHPLANE_TLS_CERTIFICATE_PATH='
  printf '%s\n' 'MATCHPLANE_TLS_PRIVATE_KEY_PATH='
  printf '%s\n' 'MATCHPLANE_TLS_CLIENT_CA_PATH='
  printf '%s\n' \
    'MATCHPLANE_CONTACT_DATA_KEY_FILE=/etc/matchplane/secrets/gateway/contact-data.key'
  printf '%s\n' 'MATCHPLANE_CONTACT_DATA_KEY_VERSION=1'
  printf '%s\n' \
    'MATCHPLANE_INVOICE_DATA_KEY_FILE=/etc/matchplane/secrets/payment/invoice-data.key'
  printf '%s\n' 'MATCHPLANE_INVOICE_DATA_KEY_VERSION=1'
  printf '%s\n' \
    'MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE=/etc/matchplane/secrets/payment/payment-admin.token'
  printf '%s\n' \
    'MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE=/etc/matchplane/secrets/gateway/gateway-admin.token'
} >"$environment_file"
install -m 0640 -o root -g matchplane "$environment_file" \
  /etc/matchplane/matchplane.env

# The test profile deliberately uses one generated runtime database/cache identity, but
# still writes one unit-scoped environment file. Recovery uses a separate root-only role/file.
# Production operators must replace runtime values with distinct role/ACL URLs and per-client
# Kafka TLS paths.
write_service_environment() {
  local service=$1
  local group=$2
  local service_file
  service_file=$(mktemp "/etc/matchplane/services/.${service}.env.XXXXXX")
  {
    printf 'MATCHPLANE_SERVICE_ROLE=%s\n' "$service"
    printf 'MATCHPLANE_DATABASE_URL=postgres://matchplane:%s@127.0.0.1:5432/matchplane\n' \
      "$database_password"
    if [[ $service != conversion-projector ]]; then
      printf '%s\n' 'MATCHPLANE_VALKEY_URL=redis://127.0.0.1:6379/'
    fi
    if [[ $service == conversion-projector ]]; then
      # Ship the workload declared but disabled. The root operator must explicitly flip this
      # after migrations, alerting, and recovery access have been verified.
      printf '%s\n' 'MATCHPLANE_CONVERSION_PROJECTOR_ENABLED=false'
      printf '%s\n' 'MATCHPLANE_CONVERSION_PROJECTOR_BATCH_SIZE=1'
      printf '%s\n' 'MATCHPLANE_CONVERSION_PROJECTOR_POLL_MS=1000'
      printf '%s\n' 'MATCHPLANE_CONVERSION_PROJECTOR_POOL_SIZE=5'
      printf '%s\n' 'MATCHPLANE_CONVERSION_PROJECTOR_DEGRADED_AFTER_SECONDS=300'
      printf '%s\n' 'MATCHPLANE_HTTP_ADDR=127.0.0.1:8082'
    fi
    if [[ $service == web ]]; then
      # EnvironmentFile entries are applied after Environment= by systemd. Keep the web
      # workload on its least-privilege token copies instead of the service-owned files.
      printf '%s\n' 'MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE=/etc/matchplane/secrets/web/payment-admin.token'
      printf '%s\n' 'MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE=/etc/matchplane/secrets/web/gateway-admin.token'
    fi
  } >"$service_file"
  install -m 0640 -o root -g "$group" "$service_file" \
    "/etc/matchplane/services/${service}.env"
  rm -f "$service_file"
}

write_service_environment web matchplane-web
write_service_environment gateway matchplane-gateway
write_service_environment payment-service matchplane-payment
write_service_environment event-relay matchplane-relay
write_service_environment conversion-projector matchplane-conversion
write_service_environment matcher matchplane-matcher
write_service_environment projector matchplane-projector
write_service_environment vector-worker matchplane-vector
write_service_environment federation-hub matchplane-federation
write_service_environment migration matchplane-migration

recovery_environment_file=$(mktemp /etc/matchplane/recovery/.conversion-projections.env.XXXXXX)
trap 'rm -f "$environment_file" "$recovery_environment_file"' EXIT
printf 'MATCHPLANE_RECOVERY_DATABASE_URL=postgres://matchplane_recovery:%s@127.0.0.1:5432/matchplane?sslmode=require\n' \
  "$recovery_database_password" >"$recovery_environment_file"
install -m 0640 -o root -g root "$recovery_environment_file" \
  /etc/matchplane/recovery/conversion-projections.env
rm -f "$recovery_environment_file"
if sudo -u matchplane-conversion -- \
  test -r /etc/matchplane/recovery/conversion-projections.env; then
  echo 'conversion projector must not read the root recovery credential' >&2
  exit 1
fi
if [[ $(stat -c '%u:%g %a' /etc/matchplane/recovery/conversion-projections.env) != '0:0 640' ]]; then
  echo 'conversion recovery credential must be root:root 0640' >&2
  exit 1
fi

systemctl daemon-reload
systemctl reset-failed matchplane-initialize.service \
  matchplane-gateway.service matchplane-payment-service.service >/dev/null 2>&1 || true
systemctl start matchplane-initialize.service
sudo -u postgres psql --set=ON_ERROR_STOP=1 matchplane <<'SQL'
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM matchplane_recovery;
REVOKE CREATE ON SCHEMA public FROM matchplane_recovery;
GRANT CONNECT ON DATABASE matchplane TO matchplane_recovery;
GRANT USAGE ON SCHEMA public TO matchplane_recovery;
GRANT SELECT, UPDATE ON marketplace_conversion_outbox TO matchplane_recovery;
GRANT SELECT ON marketplace_introduction_contact_events,
                marketplace_introductions,
                marketplace_offers,
                marketplace_parties,
                marketplace_sales_handoffs
    TO matchplane_recovery;
GRANT INSERT ON platform_audit_events TO matchplane_recovery;
SQL
systemctl enable --now matchplane-gateway.service matchplane-payment-service.service

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/health/ready >/dev/null &&
    curl --fail --silent http://127.0.0.1:8081/health/ready >/dev/null; then
    break
  fi
  sleep 1
done

curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
printf '\n'
curl --fail --silent --show-error http://127.0.0.1:8081/health/ready
printf '\n'
sudo -u postgres psql -Atqc \
  "SELECT extname || '|' || extversion FROM pg_extension \
   WHERE extname IN ('timescaledb', 'vector') ORDER BY extname" matchplane
