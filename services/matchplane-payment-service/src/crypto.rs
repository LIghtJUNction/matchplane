use std::{env, fs};

use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use matchplane_config::Environment;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invoice encryption configuration is invalid: {0}")]
    Configuration(String),
    #[error("invoice protected data could not be encrypted or decrypted")]
    Cipher,
}

#[derive(Clone)]
pub struct InvoiceCipher {
    key: [u8; 32],
    key_version: i32,
}

impl std::fmt::Debug for InvoiceCipher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InvoiceCipher")
            .field("key", &"[REDACTED]")
            .field("key_version", &self.key_version)
            .finish()
    }
}

#[derive(Debug)]
pub struct EncryptedValue {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; 12],
    pub key_version: i32,
}

impl InvoiceCipher {
    pub fn load(environment: Environment) -> Result<Self, CryptoError> {
        let key = if let Ok(path) = env::var("MATCHPLANE_INVOICE_DATA_KEY_FILE") {
            let bytes = fs::read(&path).map_err(|error| {
                CryptoError::Configuration(format!("key file cannot be read: {error}"))
            })?;
            decode_key(&bytes)?
        } else if environment != Environment::Production {
            if let Ok(value) = env::var("MATCHPLANE_INVOICE_DATA_KEY") {
                decode_key(value.as_bytes())?
            } else {
                Sha256::digest(b"matchplane-development-invoice-data-key").into()
            }
        } else {
            return Err(CryptoError::Configuration(
                "production requires MATCHPLANE_INVOICE_DATA_KEY_FILE".to_owned(),
            ));
        };
        let key_version = env::var("MATCHPLANE_INVOICE_DATA_KEY_VERSION")
            .unwrap_or_else(|_| "1".to_owned())
            .parse::<i32>()
            .map_err(|_| CryptoError::Configuration("key version must be an integer".to_owned()))?;
        if key_version <= 0 {
            return Err(CryptoError::Configuration(
                "key version must be positive".to_owned(),
            ));
        }
        Ok(Self { key, key_version })
    }

    pub fn encrypt(
        &self,
        plaintext: &[u8],
        associated_data: &[u8],
    ) -> Result<EncryptedValue, CryptoError> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| CryptoError::Cipher)?;
        let uuid = Uuid::now_v7();
        let mut nonce = [0_u8; 12];
        nonce.copy_from_slice(&uuid.as_bytes()[..12]);
        let nonce_value = aes_gcm::aead::Nonce::<Aes256Gcm>::from(nonce);
        let ciphertext = cipher
            .encrypt(
                &nonce_value,
                Payload {
                    msg: plaintext,
                    aad: associated_data,
                },
            )
            .map_err(|_| CryptoError::Cipher)?;
        Ok(EncryptedValue {
            ciphertext,
            nonce,
            key_version: self.key_version,
        })
    }

    pub fn decrypt(
        &self,
        ciphertext: &[u8],
        nonce: &[u8],
        key_version: i32,
        associated_data: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if key_version != self.key_version || nonce.len() != 12 {
            return Err(CryptoError::Cipher);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| CryptoError::Cipher)?;
        let nonce_bytes: [u8; 12] = nonce.try_into().map_err(|_| CryptoError::Cipher)?;
        let nonce_value = aes_gcm::aead::Nonce::<Aes256Gcm>::from(nonce_bytes);
        cipher
            .decrypt(
                &nonce_value,
                Payload {
                    msg: ciphertext,
                    aad: associated_data,
                },
            )
            .map_err(|_| CryptoError::Cipher)
    }
}

fn decode_key(bytes: &[u8]) -> Result<[u8; 32], CryptoError> {
    if bytes.len() == 32 {
        return bytes.try_into().map_err(|_| CryptoError::Cipher);
    }
    let text = std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| CryptoError::Configuration("key must be raw, hex, or base64".to_owned()))?;
    let decoded = if text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        hex::decode(text)
            .map_err(|_| CryptoError::Configuration("hex key is malformed".to_owned()))?
    } else {
        STANDARD
            .decode(text)
            .map_err(|_| CryptoError::Configuration("base64 key is malformed".to_owned()))?
    };
    decoded.try_into().map_err(|_| {
        CryptoError::Configuration("invoice data key must contain exactly 32 bytes".to_owned())
    })
}

#[derive(Clone)]
pub struct AdminAuth {
    token_hash: [u8; 32],
}

impl std::fmt::Debug for AdminAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AdminAuth([REDACTED])")
    }
}

impl AdminAuth {
    pub fn load(environment: Environment) -> Result<Self, CryptoError> {
        let token = if let Ok(path) = env::var("MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE") {
            fs::read_to_string(path)
                .map_err(|error| {
                    CryptoError::Configuration(format!("admin token file cannot be read: {error}"))
                })?
                .trim()
                .to_owned()
        } else if environment != Environment::Production {
            env::var("MATCHPLANE_PAYMENT_ADMIN_TOKEN")
                .unwrap_or_else(|_| "matchplane-development-admin".to_owned())
        } else {
            return Err(CryptoError::Configuration(
                "production requires MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE".to_owned(),
            ));
        };
        if token.len() < 24 {
            return Err(CryptoError::Configuration(
                "admin token must contain at least 24 bytes".to_owned(),
            ));
        }
        Ok(Self {
            token_hash: Sha256::digest(token.as_bytes()).into(),
        })
    }

    pub fn verify_bearer(&self, authorization: Option<&str>) -> bool {
        let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
            return false;
        };
        let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        bool::from(self.token_hash.ct_eq(&candidate))
    }
}
