use anyhow::Context;
use clap::{Parser, Subcommand};
use matchplane_config::{AppConfig, Environment};
use matchplane_storage::PgStore;

#[derive(Debug, Parser)]
#[command(name = "xtask", about = "MatchPlane repository automation")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Apply all embedded PostgreSQL migrations.
    Migrate,
    /// Apply migrations and idempotently install the local demo data.
    Initialize,
    /// Idempotently install the local demo data after migration.
    Bootstrap,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Migrate => migrate().await,
        Command::Initialize => initialize().await,
        Command::Bootstrap => bootstrap().await,
    }
}

async fn initialize() -> anyhow::Result<()> {
    let environment = AppConfig::load()
        .context("initialization configuration is invalid")?
        .environment;
    migrate().await?;
    if environment == Environment::Production {
        // Production initialization must never seed deterministic test payment
        // or invoice providers. The packaged unit can safely run this command
        // on a fresh database because production is migration-only.
        return Ok(());
    }
    bootstrap().await
}

async fn bootstrap() -> anyhow::Result<()> {
    let config = AppConfig::load().context("bootstrap configuration is invalid")?;
    if config.environment == Environment::Production {
        anyhow::bail!("demo bootstrap is disabled in production; run `xtask migrate` instead");
    }
    if std::env::var("MATCHPLANE_ALLOW_DEMO_BOOTSTRAP").as_deref() != Ok("true") {
        anyhow::bail!(
            "demo bootstrap requires MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true in development or test"
        );
    }
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("bootstrap runner could not connect to PostgreSQL")?;
    let ids = store
        .bootstrap_demo()
        .await
        .context("demo bootstrap failed")?;
    println!(
        "{}",
        serde_json::to_string_pretty(&ids).context("bootstrap result encoding failed")?
    );
    Ok(())
}

async fn migrate() -> anyhow::Result<()> {
    let config = AppConfig::load().context("migration configuration is invalid")?;
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("migration runner could not connect to PostgreSQL")?;
    store.migrate().await.context("database migration failed")
}
