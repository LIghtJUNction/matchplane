use std::str::FromStr;

use uuid::Error as UuidError;

use crate::ApiError;

/// Parses a UUID-backed domain identifier from a request string.
pub fn parse_id<T>(value: &str) -> Result<T, ApiError>
where
    T: FromStr<Err = UuidError>,
{
    value
        .parse()
        .map_err(|error| ApiError::bad_request(format!("invalid UUID: {error}")))
}

/// Parses an optional UUID-backed domain identifier from a request string.
pub fn parse_optional_id<T>(value: Option<&str>) -> Result<Option<T>, ApiError>
where
    T: FromStr<Err = UuidError>,
{
    value.map(parse_id).transpose()
}

/// Parses an exact base-10 integer string used by MatchPlane monetary fields.
pub fn parse_exact(value: &str) -> Result<i128, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::bad_request("exact values must be base-10 integer strings"))
}
