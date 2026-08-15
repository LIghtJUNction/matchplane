#!/usr/bin/env bash
set -euo pipefail

# Install the pinned single-host Kafka dependency used by the systemd profile.
# The archive is verified against Apache's published SHA-512 before extraction.
if [[ $(id -u) -ne 0 ]]; then
  echo 'install-kafka.sh must run as root' >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
kafka_version=${KAFKA_VERSION:-4.3.1}
kafka_archive_name="kafka_2.13-${kafka_version}.tgz"
kafka_archive=${KAFKA_ARCHIVE:-/var/tmp/$kafka_archive_name}
kafka_url="https://downloads.apache.org/kafka/${kafka_version}/${kafka_archive_name}"

case "$kafka_version" in
  4.3.1)
    expected_sha512='c7d7b2318cb51aa0c61d3246a51c349210073c5c9b754947ef965a439f2f939e8600f204e134a75ac31faf3829c9370960ef7c6a9886c8a1dbf0339a21f4c54c'
    ;;
  *)
    echo "no pinned SHA-512 is recorded for Kafka $kafka_version" >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl openjdk-21-jre-headless

if [[ ! -s $kafka_archive ]]; then
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 \
    --output "$kafka_archive" "$kafka_url"
fi
actual_sha512=$(sha512sum "$kafka_archive" | awk '{print $1}')
if [[ $actual_sha512 != "$expected_sha512" ]]; then
  echo "Kafka archive SHA-512 mismatch: expected $expected_sha512, got $actual_sha512" >&2
  exit 1
fi

if ! id kafka >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/kafka --create-home --shell /usr/sbin/nologin kafka
fi
install -d -m 0755 -o root -g root /opt/kafka/releases /etc/kafka
install -d -m 0750 -o kafka -g kafka /var/lib/kafka /var/lib/kafka/logs /run/kafka

release_dir=/opt/kafka/releases/kafka_2.13-$kafka_version
if [[ ! -x $release_dir/bin/kafka-server-start.sh ]]; then
  tmp_dir=$(mktemp -d /var/tmp/kafka-extract.XXXXXX)
  trap 'rm -rf "$tmp_dir"' EXIT
  tar --extract --gzip --file "$kafka_archive" --directory "$tmp_dir"
  extracted_dir=$tmp_dir/kafka_2.13-$kafka_version
  test -x "$extracted_dir/bin/kafka-server-start.sh"
  mv "$extracted_dir" "$release_dir"
fi
ln -sfn "$release_dir" /opt/kafka/current
chown -R root:root "$release_dir"
chmod -R a=rX,u+w "$release_dir"

install -m 0644 "$repository_root/deploy/kafka/server.properties" /etc/kafka/server.properties
install -m 0644 "$repository_root/deploy/kafka/kafka.service" /etc/systemd/system/kafka.service

if [[ ! -f /var/lib/kafka/logs/meta.properties ]]; then
  cluster_id=$(/opt/kafka/current/bin/kafka-storage.sh random-uuid)
  /opt/kafka/current/bin/kafka-storage.sh format -t "$cluster_id" -c /etc/kafka/server.properties --ignore-formatted
fi
chown -R kafka:kafka /var/lib/kafka

systemctl daemon-reload
systemctl enable --now kafka.service
for _ in $(seq 1 60); do
  if /opt/kafka/current/bin/kafka-broker-api-versions.sh --bootstrap-server 127.0.0.1:9092 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
/opt/kafka/current/bin/kafka-broker-api-versions.sh --bootstrap-server 127.0.0.1:9092 >/dev/null

for topic in \
  matchplane.commands.v1 \
  matchplane.domain-events.v1 \
  matchplane.order-book-deltas.v1 \
  matchplane.market-summaries.v1 \
  matchplane.node-health.v1; do
  /opt/kafka/current/bin/kafka-topics.sh \
    --bootstrap-server 127.0.0.1:9092 \
    --create --if-not-exists \
    --topic "$topic" \
    --partitions 12 \
    --replication-factor 1 >/dev/null
done

/opt/kafka/current/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --list
