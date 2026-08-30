use std::future::Future;

use anyhow::Context;
use matchplane_config::{AppConfig, Environment};
use matchplane_events::{KafkaPublisher, KafkaSecurityConfig};
use matchplane_observability::{init, shutdown_signal};
use matchplane_storage::PgStore;
use tokio::{
    task::JoinSet,
    time::{Duration, sleep},
};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("relay configuration is invalid")?;
    let telemetry = init(
        "matchplane-event-relay",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("relay observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 10)
        .await
        .context("relay could not connect to PostgreSQL")?;
    store.ping().await.context("relay readiness failed")?;
    store
        .ensure_local_node(
            config.node_id,
            &format!("http://{}", config.grpc_addr),
            config.environment != Environment::Production,
        )
        .await
        .context("relay local federation node registration failed")?;
    let kafka_security = KafkaSecurityConfig {
        protocol: config.kafka_security_protocol.clone(),
        ca_location: Some(config.kafka_ssl_ca_location.clone()).filter(|path| !path.is_empty()),
        certificate_location: Some(config.kafka_ssl_certificate_location.clone())
            .filter(|path| !path.is_empty()),
        key_location: Some(config.kafka_ssl_key_location.clone()).filter(|path| !path.is_empty()),
    };
    let publisher = KafkaPublisher::new(
        &config.kafka_brokers,
        "matchplane-event-relay",
        &kafka_security,
    )
    .context("relay could not configure Kafka")?;
    info!(node_id = %config.node_id, "outbox relay ready");
    loop {
        tokio::select! {
            () = shutdown_signal() => break,
            result = relay_once(&store, &publisher) => result?,
        }
    }
    info!("outbox relay stopped cleanly");
    telemetry
        .shutdown()
        .context("relay telemetry shutdown failed")?;
    Ok(())
}

async fn relay_once(store: &PgStore, publisher: &KafkaPublisher) -> anyhow::Result<()> {
    let messages = store
        .claim_outbox(100)
        .await
        .context("outbox claim failed")?;
    if messages.is_empty() {
        sleep(Duration::from_millis(100)).await;
        return Ok(());
    }
    run_concurrently(messages, |message| {
        let store = store.clone();
        let publisher = publisher.clone();
        async move { relay_message(&store, &publisher, message).await }
    })
    .await
}

async fn relay_message(
    store: &PgStore,
    publisher: &KafkaPublisher,
    message: matchplane_storage::OutboxMessage,
) -> anyhow::Result<()> {
    match publisher
        .publish(&message.topic, &message.message_key, &message.payload)
        .await
    {
        Ok(()) => store
            .mark_outbox_published(message.event_id, message.claim_token)
            .await
            .context("outbox acknowledgement failed"),
        Err(error) => {
            warn!(
                event_id = %message.event_id,
                topic = %message.topic,
                message_key = %message.message_key,
                shard_sequence = message.shard_sequence,
                attempts = message.attempts,
                %error,
                "Kafka publication failed"
            );
            store
                .mark_outbox_failed(
                    message.event_id,
                    message.claim_token,
                    message.attempts,
                    &error.to_string(),
                )
                .await
                .context("outbox retry transition failed")
        }
    }
}

async fn run_concurrently<T, F, Fut>(items: Vec<T>, process: F) -> anyhow::Result<()>
where
    T: Send + 'static,
    F: Fn(T) -> Fut,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let mut tasks = JoinSet::new();
    for item in items {
        tasks.spawn(process(item));
    }

    let mut first_error = None;
    while let Some(result) = tasks.join_next().await {
        let result = match result {
            Ok(result) => result,
            Err(error) => Err(anyhow::Error::from(error).context("outbox publication task failed")),
        };
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use tokio::{sync::Barrier, time::timeout};

    use super::*;

    #[tokio::test]
    async fn claimed_batch_starts_concurrently_and_drains_after_an_error() -> anyhow::Result<()> {
        let barrier = Arc::new(Barrier::new(2));
        let completed = Arc::new(AtomicUsize::new(0));
        let result = timeout(
            Duration::from_secs(1),
            run_concurrently(vec![false, true], {
                let barrier = Arc::clone(&barrier);
                let completed = Arc::clone(&completed);
                move |fail| {
                    let barrier = Arc::clone(&barrier);
                    let completed = Arc::clone(&completed);
                    async move {
                        barrier.wait().await;
                        completed.fetch_add(1, Ordering::SeqCst);
                        if fail {
                            return Err(anyhow::anyhow!("simulated publish failure"));
                        }
                        Ok(())
                    }
                }
            }),
        )
        .await
        .context("sequential dispatch consumed the claim lease while waiting")?;

        assert!(result.is_err());
        assert_eq!(completed.load(Ordering::SeqCst), 2);
        Ok(())
    }
}
