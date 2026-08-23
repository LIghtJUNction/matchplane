//! Application-layer use cases and ports for MatchPlane.
//!
//! Service adapters should delegate business orchestration here instead of
//! embedding it in HTTP handlers or PostgreSQL repositories.

mod error;
mod http;
mod marketplace;
mod orders;
mod ports;

pub use error::ApplicationError;
pub use marketplace::{ListOffersQuery, MarketplaceService, MarketplaceWriter, UpdateOfferCommand};
pub use orders::{OrderService, PlaceOrderCommand, PlaceOrderOutcome};
pub use ports::OrderWriter;
