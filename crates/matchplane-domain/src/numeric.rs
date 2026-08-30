use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors raised while constructing or operating on exact numeric values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum NumericError {
    /// A price must be strictly positive.
    #[error("price must be greater than zero")]
    NonPositivePrice,
    /// An order quantity must be strictly positive.
    #[error("quantity must be greater than zero")]
    NonPositiveQuantity,
    /// A quantity operation would become negative.
    #[error("quantity would become negative")]
    NegativeQuantity,
    /// Checked integer arithmetic overflowed.
    #[error("exact integer arithmetic overflow")]
    Overflow,
    /// A market scale exceeds the supported precision.
    #[error("scale must be between 0 and 18")]
    InvalidScale,
}

/// A strictly positive, market-scaled integer price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Price(i128);

impl Price {
    /// Creates a validated positive price.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::NonPositivePrice`] when `value` is zero or negative.
    pub const fn new(value: i128) -> Result<Self, NumericError> {
        if value > 0 {
            Ok(Self(value))
        } else {
            Err(NumericError::NonPositivePrice)
        }
    }

    /// Returns the scaled integer value.
    #[must_use]
    pub const fn value(self) -> i128 {
        self.0
    }

    /// Multiplies a price by a quantity with overflow checking.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::Overflow`] when the product exceeds `i128`.
    pub fn checked_mul(self, quantity: Quantity) -> Result<Amount, NumericError> {
        self.0
            .checked_mul(quantity.0)
            .map(Amount)
            .ok_or(NumericError::Overflow)
    }
}

impl<'de> Deserialize<'de> for Price {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(i128::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for Price {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A non-negative, market-scaled integer quantity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Quantity(i128);

impl Quantity {
    /// The zero quantity used for filled states.
    pub const ZERO: Self = Self(0);

    /// Creates a strictly positive order quantity.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::NonPositiveQuantity`] when `value` is not positive.
    pub const fn new(value: i128) -> Result<Self, NumericError> {
        if value > 0 {
            Ok(Self(value))
        } else {
            Err(NumericError::NonPositiveQuantity)
        }
    }

    /// Creates an internal remaining quantity that may be zero.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::NegativeQuantity`] for a negative value.
    pub const fn from_non_negative(value: i128) -> Result<Self, NumericError> {
        if value >= 0 {
            Ok(Self(value))
        } else {
            Err(NumericError::NegativeQuantity)
        }
    }

    /// Returns the scaled integer value.
    #[must_use]
    pub const fn value(self) -> i128 {
        self.0
    }

    /// Returns whether the quantity is zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Adds quantities with overflow checking.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::Overflow`] when the sum exceeds `i128`.
    pub fn checked_add(self, other: Self) -> Result<Self, NumericError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(NumericError::Overflow)
    }

    /// Subtracts quantities without allowing a negative result.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::NegativeQuantity`] when `other` is larger.
    pub fn checked_sub(self, other: Self) -> Result<Self, NumericError> {
        let value = self.0.checked_sub(other.0).ok_or(NumericError::Overflow)?;
        Self::from_non_negative(value)
    }
}

impl<'de> Deserialize<'de> for Quantity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::from_non_negative(i128::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for Quantity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A signed exact amount used by the double-entry ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Amount(i128);

impl Amount {
    /// Creates an amount from a scaled integer.
    #[must_use]
    pub const fn new(value: i128) -> Self {
        Self(value)
    }

    /// Returns the scaled integer value.
    #[must_use]
    pub const fn value(self) -> i128 {
        self.0
    }

    /// Negates the amount with overflow checking.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::Overflow`] for `i128::MIN`.
    pub fn checked_neg(self) -> Result<Self, NumericError> {
        self.0.checked_neg().map(Self).ok_or(NumericError::Overflow)
    }
}

impl fmt::Display for Amount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A decimal scale stored on a market.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Scale(u8);

impl Scale {
    /// Creates a scale up to 18 decimal places.
    ///
    /// # Errors
    ///
    /// Returns [`NumericError::InvalidScale`] for unsupported precision.
    pub const fn new(value: u8) -> Result<Self, NumericError> {
        if value <= 18 {
            Ok(Self(value))
        } else {
            Err(NumericError::InvalidScale)
        }
    }

    /// Returns the number of decimal places.
    #[must_use]
    pub const fn value(self) -> u8 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Scale {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(u8::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::{Price, Quantity, Scale};

    #[test]
    fn deserialization_preserves_numeric_invariants() {
        assert!(serde_json::from_str::<Price>("-1").is_err());
        assert!(serde_json::from_str::<Price>("0").is_err());
        assert!(serde_json::from_str::<Quantity>("-1").is_err());
        assert!(matches!(
            serde_json::from_str::<Quantity>("0").map(Quantity::value),
            Ok(0)
        ));
        assert!(serde_json::from_str::<Scale>("19").is_err());
    }
}
