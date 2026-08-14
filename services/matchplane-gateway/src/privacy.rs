use std::{env, fs};

use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use matchplane_config::Environment;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PrivacyError {
    #[error("contact encryption configuration is invalid: {0}")]
    Configuration(String),
    #[error("protected contact data could not be encrypted or decrypted")]
    Cipher,
}

#[derive(Clone)]
pub struct ContactCipher {
    key: [u8; 32],
    key_version: i32,
}

impl std::fmt::Debug for ContactCipher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ContactCipher")
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

impl ContactCipher {
    pub fn load(environment: Environment) -> Result<Self, PrivacyError> {
        let key = if let Ok(path) = env::var("MATCHPLANE_CONTACT_DATA_KEY_FILE") {
            let bytes = fs::read(path).map_err(|error| {
                PrivacyError::Configuration(format!("key file cannot be read: {error}"))
            })?;
            decode_key(&bytes)?
        } else if environment != Environment::Production {
            if let Ok(value) = env::var("MATCHPLANE_CONTACT_DATA_KEY") {
                decode_key(value.as_bytes())?
            } else {
                Sha256::digest(b"matchplane-development-contact-data-key").into()
            }
        } else {
            return Err(PrivacyError::Configuration(
                "production requires MATCHPLANE_CONTACT_DATA_KEY_FILE".to_owned(),
            ));
        };
        let key_version = env::var("MATCHPLANE_CONTACT_DATA_KEY_VERSION")
            .unwrap_or_else(|_| "1".to_owned())
            .parse::<i32>()
            .map_err(|_| {
                PrivacyError::Configuration("key version must be an integer".to_owned())
            })?;
        if key_version <= 0 {
            return Err(PrivacyError::Configuration(
                "key version must be positive".to_owned(),
            ));
        }
        Ok(Self { key, key_version })
    }

    pub fn encrypt(
        &self,
        plaintext: &[u8],
        associated_data: &[u8],
    ) -> Result<EncryptedValue, PrivacyError> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| PrivacyError::Cipher)?;
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
            .map_err(|_| PrivacyError::Cipher)?;
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
    ) -> Result<Vec<u8>, PrivacyError> {
        if key_version != self.key_version || nonce.len() != 12 {
            return Err(PrivacyError::Cipher);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| PrivacyError::Cipher)?;
        let nonce_bytes: [u8; 12] = nonce.try_into().map_err(|_| PrivacyError::Cipher)?;
        let nonce_value = aes_gcm::aead::Nonce::<Aes256Gcm>::from(nonce_bytes);
        cipher
            .decrypt(
                &nonce_value,
                Payload {
                    msg: ciphertext,
                    aad: associated_data,
                },
            )
            .map_err(|_| PrivacyError::Cipher)
    }
}

fn decode_key(bytes: &[u8]) -> Result<[u8; 32], PrivacyError> {
    if bytes.len() == 32 {
        return bytes.try_into().map_err(|_| PrivacyError::Cipher);
    }
    let text = std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| PrivacyError::Configuration("key must be raw, hex, or base64".to_owned()))?;
    let decoded = if text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        hex::decode(text)
            .map_err(|_| PrivacyError::Configuration("hex key is malformed".to_owned()))?
    } else {
        STANDARD
            .decode(text)
            .map_err(|_| PrivacyError::Configuration("base64 key is malformed".to_owned()))?
    };
    decoded.try_into().map_err(|_| {
        PrivacyError::Configuration("contact data key must contain exactly 32 bytes".to_owned())
    })
}
