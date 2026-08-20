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
    /// Register or replace a provider definition.
    pub fn register(&mut self, provider: ProviderDefinition) {
        self.providers.insert(provider.id.clone(), provider);
    }

    /// Find an enabled provider by identifier.
    pub fn get_enabled(&self, id: &str) -> Option<&ProviderDefinition> {
        self.providers
            .get(id)
            .filter(|provider| provider.enabled)
    }

    /// List enabled providers of a category.
    pub fn enabled_of_kind(&self, kind: ProviderKind) -> Vec<&ProviderDefinition> {
        self.providers
            .values()
            .filter(|provider| provider.enabled && provider.kind == kind)
            .collect()
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
}
