.PHONY: check compose-config dev down migrate smoke package-check

check:
	cargo fmt --check
	cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
	cargo test --workspace --locked

compose-config:
	docker compose --env-file .env.example -f deploy/compose/compose.yaml config --quiet

dev:
	docker compose --env-file .env.example -f deploy/compose/compose.yaml up --build -d

down:
	docker compose --env-file .env.example -f deploy/compose/compose.yaml down

migrate:
	cargo run --locked -p xtask -- migrate

smoke:
	./tests/integration/smoke.sh

package-check:
	./packaging/scripts/check.sh
