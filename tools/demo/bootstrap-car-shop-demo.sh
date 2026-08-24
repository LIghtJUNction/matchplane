#!/usr/bin/env bash
set -euo pipefail

# Challenge #11 demo bootstrap: one hosted car-selling store with six public offers.
#
# This is a development-only convenience, the seeded records live in tools/demo/car-shop-seed.sql
# (the same explicit-boundary pattern as tests/integration/fixture.sql).  It never runs against a
# production profile and never touches accounts, payments, or SMTP configuration.
#
# Usage (from the repository root, with local Compose running and migrations applied):
#   just migrate
#   ./tools/demo/bootstrap-car-shop-demo.sh
#
# Recognized environment overrides (compose development defaults otherwise):
#   MATCHPLANE_DATABASE_URL           postgres://matchplane:matchplane_dev_only@127.0.0.1:5432/matchplane
#   MATCHPLANE_ROOT_TENANT_ID         reuse an already-provisioned root tenant
#   MATCHPLANE_HOSTED_MEDIA_HOST_ROOT host directory mounted at /var/lib/matchplane/media in Compose

demo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$demo_dir/../.." && pwd)

read_env_file_value() {
  local key=$1
  [[ -f "$repo_root/.env" ]] || return 0
  sed -n "s/^${key}=//p" "$repo_root/.env" | tail -n 1
}

environment=${MATCHPLANE_ENVIRONMENT:-$(read_env_file_value MATCHPLANE_ENVIRONMENT)}
if [[ "${environment:-development}" == "production" ]]; then
  echo "refusing to seed demo data into a production profile" >&2
  exit 1
fi

database_url=${MATCHPLANE_DATABASE_URL:-$(read_env_file_value MATCHPLANE_DATABASE_URL)}
database_url=${database_url:-postgres://matchplane:matchplane_dev_only@127.0.0.1:5432/matchplane}

tenant_id=${MATCHPLANE_ROOT_TENANT_ID:-$(read_env_file_value MATCHPLANE_ROOT_TENANT_ID)}
tenant_id=${tenant_id:-00000000-0000-7000-8000-000000001100}
if ! [[ "$tenant_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  echo "MATCHPLANE_ROOT_TENANT_ID must be a lowercase UUID, got: $tenant_id" >&2
  exit 1
fi

media_host_root=${MATCHPLANE_HOSTED_MEDIA_HOST_ROOT:-$(read_env_file_value MATCHPLANE_HOSTED_MEDIA_HOST_ROOT)}
media_host_root=${media_host_root:-$repo_root/deploy/compose/var/hosted-media}

command -v psql >/dev/null || {
  echo "psql is required (for example: apt install postgresql-client)" >&2
  exit 1
}

store_id=00000000-0000-7000-8000-000000001104
store_media_dir="$media_host_root/$tenant_id/$store_id"
mkdir -p "$store_media_dir"

# Copy the demo images to the hosted-media layout and collect size/sha256 psql variables.
psql_media_args=()
for index in 1 2 3 4 5 6; do
  source_file="$demo_dir/media/car-0${index}.svg"
  media_id="00000000-0000-7000-8000-00000000111${index}"
  cp "$source_file" "$store_media_dir/$media_id.svg"
  size=$(wc -c < "$source_file" | tr -d ' ')
  sha=$(sha256sum "$source_file" | cut -d' ' -f1)
  psql_media_args+=(-v "media${index}_size=$size" -v "media${index}_sha=$sha")
done

# High-entropy capability token for the seeded seller party.  Only its SHA-256 is stored; the
# raw value is printed once so more cars can be published through /v1/marketplace/offers.
seller_token="demo-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

psql "$database_url" \
  --set=ON_ERROR_STOP=1 \
  -v tenant_id="$tenant_id" \
  -v seller_token="$seller_token" \
  "${psql_media_args[@]}" \
  -f "$demo_dir/car-shop-seed.sql"

cat <<SUMMARY

Challenge #11 car shop demo is seeded.

  demo tenant id     $tenant_id
  demo store slug    demo-car-shop
  storefront path    /demo-car-shop
  hosted media dir   $store_media_dir
  seller API token   $seller_token   (shown once; SHA-256 stored)

Next steps when this created a new tenant:
  1. Set MATCHPLANE_ROOT_TENANT_ID=$tenant_id in .env and restart the web service.
  2. Register the first account on /login (development profile with
     MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true skips the SMTP requirement).
  3. Open / for the buyer mall and /demo-car-shop for the store page.

See docs/challenge-11-demo-script.zh-CN.md for the full sponsor click path.
SUMMARY
