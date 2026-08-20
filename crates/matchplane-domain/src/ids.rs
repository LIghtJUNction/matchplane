use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates a time-ordered UUIDv7 identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            /// Wraps an existing UUID.
            #[must_use]
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            /// Returns the underlying UUID.
            #[must_use]
            pub const fn into_uuid(self) -> Uuid {
                self.0
            }

            /// Borrows the underlying UUID.
            #[must_use]
            pub const fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

id_type!(
    #[doc = "Identifies a tenant boundary."]
    TenantId
);
id_type!(
    #[doc = "Identifies a vertical domain."]
    DomainId
);
id_type!(
    #[doc = "Identifies a versioned asset schema."]
    AssetSchemaId
);
id_type!(
    #[doc = "Identifies an asset."]
    AssetId
);
id_type!(
    #[doc = "Identifies a balance and ledger account."]
    AccountId
);
id_type!(
    #[doc = "Identifies an embedding model."]
    EmbeddingModelId
);
id_type!(
    #[doc = "Identifies a market."]
    MarketId
);
id_type!(
    #[doc = "Identifies an order."]
    OrderId
);
id_type!(
    #[doc = "Identifies a reservation."]
    ReservationId
);
id_type!(
    #[doc = "Identifies an external or sandbox payment intent."]
    PaymentId
);
id_type!(
    #[doc = "Identifies a configured payment gateway."]
    PaymentGatewayId
);
id_type!(
    #[doc = "Identifies a payment refund."]
    RefundId
);
id_type!(
    #[doc = "Identifies a managed invoice."]
    InvoiceId
);
id_type!(
    #[doc = "Identifies a buyer or seller marketplace party."]
    MarketplacePartyId
);
id_type!(
    #[doc = "Identifies a domain-neutral demand/supply introduction."]
    MatchIntroductionId
);
id_type!(
    #[doc = "Identifies a domain-neutral demand or supply intent."]
    MarketplaceIntentId
);
id_type!(
    #[doc = "Identifies a domain-neutral supply offer."]
    MarketplaceOfferId
);
id_type!(
    #[doc = "Identifies a durable marketplace behavior event."]
    MarketplaceBehaviorEventId
);
id_type!(
    #[doc = "Identifies a sales handoff request."]
    MarketplaceSalesHandoffId
);
id_type!(
    #[doc = "Identifies a seller-funded promotion campaign."]
    PromotionCampaignId
);
id_type!(
    #[doc = "Identifies a vehicle offered by a seller."]
    VehicleListingId
);
id_type!(
    #[doc = "Identifies a buyer's structured vehicle request."]
    BuyerRequestId
);
id_type!(
    #[doc = "Identifies a privacy-controlled buyer/seller introduction."]
    OfflineDealId
);
id_type!(
    #[doc = "Identifies an offline vehicle viewing appointment."]
    ViewingAppointmentId
);
id_type!(
    #[doc = "Identifies a trade."]
    TradeId
);
id_type!(
    #[doc = "Identifies a ledger entry."]
    LedgerEntryId
);
id_type!(
    #[doc = "Identifies an event or command."]
    EventId
);
id_type!(
    #[doc = "Identifies a federation node."]
    FederationNodeId
);
id_type!(
    #[doc = "Identifies a federation subscription."]
    FederationSubscriptionId
);
id_type!(
    #[doc = "Identifies a logical order-book shard."]
    ShardId
);
id_type!(
    #[doc = "Connects operations in one request flow."]
    CorrelationId
);
id_type!(
    #[doc = "Identifies the direct cause of an event."]
    CausationId
);

impl EventId {
    /// Deterministically derives a child event ID from a command ID and ordinal.
    #[must_use]
    pub fn derive(self, label: &str, ordinal: u32) -> Self {
        let name = format!("{label}:{ordinal}");
        Self(Uuid::new_v5(self.as_uuid(), name.as_bytes()))
    }
}

impl TradeId {
    /// Deterministically derives a trade ID from its command and match ordinal.
    #[must_use]
    pub fn derive(command_id: EventId, ordinal: u32) -> Self {
        let name = format!("trade:{ordinal}");
        Self(Uuid::new_v5(command_id.as_uuid(), name.as_bytes()))
    }
}

impl ReservationId {
    /// Deterministically derives the reservation owned by a placement command.
    #[must_use]
    pub fn derive(command_id: EventId) -> Self {
        Self(Uuid::new_v5(
            command_id.as_uuid(),
            b"matchplane-reservation",
        ))
    }
}

impl LedgerEntryId {
    /// Deterministically derives a ledger posting ID from a trade ID and posting label.
    #[must_use]
    pub fn derive(trade_id: TradeId, label: &str) -> Self {
        Self(Uuid::new_v5(trade_id.as_uuid(), label.as_bytes()))
    }
}

impl From<EventId> for CausationId {
    fn from(value: EventId) -> Self {
        Self::from_uuid(value.into_uuid())
    }
}
