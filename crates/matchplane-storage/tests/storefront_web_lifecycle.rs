use std::{env, io, path::PathBuf, process::Command};

use sqlx::PgPool;
use url::Url;

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires loopback PostgreSQL with MatchPlane extensions and Bun; CI runs it explicitly"]
async fn web_storefront_lifecycle_uses_live_postgresql(
    pool: PgPool,
) -> Result<(), Box<dyn std::error::Error>> {
    let current_database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await?;
    let base_url = env::var("DATABASE_URL")?;
    let mut isolated_url = Url::parse(&base_url)?;
    let host = isolated_url.host_str().unwrap_or_default();
    if !matches!(host, "127.0.0.1" | "::1" | "localhost") {
        return Err(
            io::Error::other("storefront lifecycle tests refuse non-loopback PostgreSQL").into(),
        );
    }
    let base_database = isolated_url.path().trim_start_matches('/');
    if current_database == base_database {
        return Err(io::Error::other(
            "SQLx did not allocate an isolated storefront lifecycle database",
        )
        .into());
    }
    isolated_url.set_path(&format!("/{current_database}"));

    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let runner = env::var("MATCHPLANE_TEST_WEB_RUNNER").unwrap_or_else(|_| "bun".to_owned());
    let status = Command::new(&runner)
        .arg("run")
        .arg("src/storefront-lifecycle.postgres.ts")
        .current_dir(repository_root.join("web"))
        .env_remove("DATABASE_URL")
        .env_remove("MATCHPLANE_DATABASE_URL")
        .env("NODE_ENV", "test")
        .env("MATCHPLANE_ENVIRONMENT", "test")
        .env("BETTER_AUTH_URL", "http://127.0.0.1:3000")
        .env("BETTER_AUTH_SECRET", "postgres-lifecycle-test-secret-only")
        .env("MATCHPLANE_AUTH_POOL_SIZE", "1")
        .env("MATCHPLANE_TEST_DATABASE_URL", isolated_url.as_str())
        .env("MATCHPLANE_TEST_DATABASE_NAME", &current_database)
        .status()?;

    if !status.success() {
        return Err(io::Error::other(format!(
            "{runner} storefront lifecycle harness exited with {status}"
        ))
        .into());
    }
    Ok(())
}
