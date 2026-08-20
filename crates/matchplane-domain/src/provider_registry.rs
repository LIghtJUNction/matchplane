//! Provider registry primitives used by application services.
//!
//! The registry keeps provider discovery independent from concrete OAuth,
//! model, payment, and notification implementations.

use std::collections::BTreeMap;

use crate::provider::{ProviderCapability, ProviderDescriptor};

/// In-memory provider registry owned by the application layer.
#[derive(Debug, Default)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, ProviderDescriptor>,
}

impl ProviderRegistry {
    /// Creates an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers or replaces a provider definition.
    pub fn register(&mut self, provider: ProviderDescriptor) {
        self.providers.insert(provider.id().to_owned(), provider);
    }

    /// Returns all enabled providers.
    #[must_use]
    pub fn enabled(&self) -> Vec<&ProviderDescriptor> {
        self.providers
            .values()
            .filter(|provider| provider.enabled())
            .collect()
    }

    /// Returns enabled providers supporting a capability.
    #[must_use]
    pub fn by_capability(&self, capability: ProviderCapability) -> Vec<&ProviderDescriptor> {
        self.providers
            .values()
            .filter(|provider| provider.enabled() && provider.capability() == capability)
            .collect()
    }
}
