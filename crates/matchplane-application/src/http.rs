use matchplane_http::ApiError;

use crate::ApplicationError;

impl From<ApplicationError> for ApiError {
    fn from(error: ApplicationError) -> Self {
        match error {
            ApplicationError::Validation(message) => ApiError::bad_request(message),
            ApplicationError::Storage(storage) => ApiError::from(storage),
        }
    }
}
