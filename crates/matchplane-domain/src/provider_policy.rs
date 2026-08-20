//! Domain policies for configurable external providers.

use crate::ProviderCapability;

/// Controls whether a provider can participate in a workflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAvailability {
    Enabled,
    Disabled,
}

/// Runtime-independent policy describing provider selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderPolicy {
    capability: ProviderCapability,
    availability: ProviderAvailability,
}

impl ProviderPolicy {
    /// Creates a policy for a provider capability.
    pub const fn new(capability: ProviderCapability) -> Self {
        Self {
            capability,
            availability: ProviderAvailability::Enabled,
        }
    }

    pub const fn capability(&self) -> ProviderCapability {
        self.capability
    }

    pub const fn is_enabled(&self) -> bool {
        matches!(self.availability, ProviderAvailability::Enabled)
    }

    pub const fn disable(mut self) -> Self {
        self.availability = ProviderAvailability::Disabled;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_policy_is_not_available() {
        let policy = ProviderPolicy::new(ProviderCapability::Authentication).disable();
        assert!(!policy.is_enabled());
    }
}
