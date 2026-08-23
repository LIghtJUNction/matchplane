//! Backend provider registry primitives.
//!
//! This module keeps service configuration independent from concrete vendors.
//! New OAuth, AI, payment, or notification providers can be registered without
//! changing domain code.

use std::collections::BTreeMap;

/// A configured external capability provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDefinition {
    /// Stable provider identifier.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Provider family, such as oauth, ai, or payment.
    pub kind: ProviderKind,
    /// Whether the provider can be used.
    pub enabled: bool,
}

/// Supported provider categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Identity providers.
    OAuth,
    /// Language model providers.
    Ai,
    /// Payment providers.
    Payment,
    /// Messaging providers.
    Notification,
}

/// In-memory registry used by application services.
#[derive(Debug, Default)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, ProviderDefinition>,
}

impl ProviderRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register or replace a provider definition.
    pub fn register(&mut self, provider: ProviderDefinition) {
        self.providers.insert(provider.id.clone(), provider);
    }

    /// Returns the number of configured providers, including disabled entries.
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    /// Returns whether the registry contains no providers.
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// Find an enabled provider by identifier.
    pub fn get_enabled(&self, id: &str) -> Option<&ProviderDefinition> {
        self.providers.get(id).filter(|provider| provider.enabled)
    }

    /// List enabled providers of a category.
    pub fn enabled_of_kind(&self, kind: ProviderKind) -> Vec<&ProviderDefinition> {
        self.providers
            .values()
            .filter(|provider| provider.enabled && provider.kind == kind)
            .collect()
    }

    /// List all configured providers in stable identifier order.
    pub fn all(&self) -> Vec<&ProviderDefinition> {
        self.providers.values().collect()
    }
}

/// Builds a [`ProviderRegistry`] from static or database-backed definitions.
#[derive(Debug, Default)]
pub struct ProviderRegistryBuilder {
    providers: Vec<ProviderDefinition>,
}

impl ProviderRegistryBuilder {
    /// Creates an empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a provider definition to the builder.
    pub fn provider(mut self, provider: ProviderDefinition) -> Self {
        self.providers.push(provider);
        self
    }

    /// Materializes the registry, with later entries replacing earlier ones
    /// for the same identifier.
    pub fn build(self) -> ProviderRegistry {
        let mut registry = ProviderRegistry::new();
        for provider in self.providers {
            registry.register(provider);
        }
        registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_filters_disabled_providers() {
        let mut registry = ProviderRegistry::default();
        registry.register(ProviderDefinition {
            id: "google".into(),
            name: "Google".into(),
            kind: ProviderKind::OAuth,
            enabled: true,
        });
        registry.register(ProviderDefinition {
            id: "legacy".into(),
            name: "Legacy".into(),
            kind: ProviderKind::OAuth,
            enabled: false,
        });

        assert_eq!(registry.enabled_of_kind(ProviderKind::OAuth).len(), 1);
        assert!(registry.get_enabled("legacy").is_none());
    }

    #[test]
    fn builder_replaces_duplicate_identifiers() {
        let registry = ProviderRegistryBuilder::new()
            .provider(ProviderDefinition {
                id: "google".into(),
                name: "Google v1".into(),
                kind: ProviderKind::OAuth,
                enabled: false,
            })
            .provider(ProviderDefinition {
                id: "google".into(),
                name: "Google v2".into(),
                kind: ProviderKind::OAuth,
                enabled: true,
            })
            .build();

        assert_eq!(registry.len(), 1);
        assert_eq!(registry.get_enabled("google").expect("provider").name, "Google v2");
    }
}
