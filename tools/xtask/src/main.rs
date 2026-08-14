use anyhow::Context;
use clap::{Parser, Subcommand};
use matchplane_config::AppConfig;
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
    migrate().await?;
    bootstrap().await
}

async fn bootstrap() -> anyhow::Result<()> {
    let config = AppConfig::load().context("bootstrap configuration is invalid")?;
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
