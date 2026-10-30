use super::config::{patterns_match, read_limited, Endpoint};
use crate::{NativeError, Result};
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::ssh_key::known_hosts::{Entry, HostPatterns, Marker};
use russh::keys::{Algorithm, PublicKey};
use sha1::Sha1;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINE: usize = 16 * 1024;

fn error(code: &'static str) -> NativeError {
    NativeError::new(code, "SSH host key verification failed")
}
fn name(endpoint: &Endpoint) -> String {
    if endpoint.port == 22 {
        endpoint.host.to_lowercase()
    } else {
        format!("[{}]:{}", endpoint.host.to_lowercase(), endpoint.port)
    }
}

fn matches(patterns: &HostPatterns, host: &str) -> bool {
    match patterns {
        HostPatterns::Patterns(patterns) => patterns_match(
            &patterns
                .iter()
                .map(|p| p.to_lowercase())
                .collect::<Vec<_>>(),
            host,
        ),
        HostPatterns::HashedName { salt, hash } => {
            let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(salt) else {
                return false;
            };
            mac.update(host.as_bytes());
            mac.verify_slice(hash).is_ok()
        }
    }
}

fn entries(bytes: &[u8], host: &str) -> Result<Vec<Entry>> {
    let text = std::str::from_utf8(bytes).map_err(|_| error("SSH_KNOWN_HOSTS_INVALID"))?;
    let mut result = Vec::new();
    for line in text.lines() {
        if line.len() > MAX_LINE {
            return Err(error("SSH_KNOWN_HOSTS_LIMIT"));
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Comments are immaterial to the key. Normalize whitespace accepted by OpenSSH.
        let fields: Vec<_> = line.split_whitespace().take(5).collect();
        let count = if line.starts_with('@') { 4 } else { 3 };
        if fields.len() < count {
            return Err(error("SSH_KNOWN_HOSTS_INVALID"));
        }
        let entry: Entry = fields[..count]
            .join(" ")
            .parse()
            .map_err(|_| error("SSH_KNOWN_HOSTS_INVALID"))?;
        if matches(entry.host_patterns(), host) {
            result.push(entry);
        }
    }
    Ok(result)
}

fn verify(entries: &[Entry], key: &PublicKey) -> Result<bool> {
    if entries.iter().any(|e| {
        e.marker() == Some(&Marker::Revoked) && e.public_key().key_data() == key.key_data()
    }) {
        return Err(error("SSH_HOST_KEY_REVOKED"));
    }
    if entries
        .iter()
        .any(|e| e.marker().is_none() && e.public_key().key_data() == key.key_data())
    {
        return Ok(true);
    }
    if entries.iter().any(|e| e.marker().is_none()) {
        return Err(error("SSH_HOST_KEY_CHANGED"));
    }
    if entries
        .iter()
        .any(|e| e.marker() == Some(&Marker::CertAuthority))
    {
        return Err(error("SSH_HOST_CERTIFICATE_UNSUPPORTED"));
    }
    Ok(false)
}

/// Prefer already pinned key algorithms while keeping the library's supported algorithms.
pub fn preferred(endpoint: &Endpoint) -> Result<russh::Preferred> {
    let bytes = read_limited(&endpoint.known_hosts, MAX_BYTES)?.unwrap_or_default();
    let saved = entries(&bytes, &name(endpoint))?;
    let mut preferred = russh::Preferred::default();
    let is_saved = |algorithm: &Algorithm| {
        saved.iter().any(|entry| {
            entry.marker().is_none() && {
                let stored = entry.public_key().algorithm();
                stored == *algorithm || stored.is_rsa() && algorithm.clone().is_rsa()
            }
        })
    };
    let mut algorithms = preferred.key.to_vec();
    algorithms.sort_by_key(|a| !is_saved(a));
    preferred.key = std::borrow::Cow::Owned(algorithms);
    Ok(preferred)
}

/// Lock, re-read, verify and append. Failure to persist a new key refuses the connection.
pub fn check(endpoint: &Endpoint, key: &PublicKey) -> Result<()> {
    let host = name(endpoint);
    if !endpoint.accept_new {
        let bytes = read_limited(&endpoint.known_hosts, MAX_BYTES)?.unwrap_or_default();
        return if verify(&entries(&bytes, &host)?, key)? {
            Ok(())
        } else {
            Err(error("SSH_HOST_KEY_UNKNOWN"))
        };
    }
    if let Some(parent) = endpoint.known_hosts.parent() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(|_| error("SSH_KNOWN_HOSTS_WRITE_FAILED"))?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(parent).map_err(|_| error("SSH_KNOWN_HOSTS_WRITE_FAILED"))?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&endpoint.known_hosts)
        .map_err(|_| error("SSH_KNOWN_HOSTS_WRITE_FAILED"))?;
    file.try_lock().map_err(|_| error("SSH_KNOWN_HOSTS_BUSY"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("SSH_KNOWN_HOSTS_READ_FAILED"))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err(error("SSH_KNOWN_HOSTS_LIMIT"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("SSH_KNOWN_HOSTS_READ_FAILED"))?;
    if bytes.len() > MAX_BYTES {
        return Err(error("SSH_KNOWN_HOSTS_LIMIT"));
    }
    if verify(&entries(&bytes, &host)?, key)? {
        return Ok(());
    }
    let public = key
        .to_openssh()
        .map_err(|_| error("SSH_HOST_KEY_INVALID"))?;
    let record = format!(
        "{}{} {}\n",
        if bytes.is_empty() || bytes.ends_with(b"\n") {
            ""
        } else {
            "\n"
        },
        host,
        public
    );
    if bytes.len() + record.len() > MAX_BYTES {
        return Err(error("SSH_KNOWN_HOSTS_LIMIT"));
    }
    file.seek(SeekFrom::End(0))
        .and_then(|_| file.write_all(record.as_bytes()))
        .and_then(|_| file.sync_data())
        .map_err(|_| error("SSH_KNOWN_HOSTS_WRITE_FAILED"))?;
    Ok(())
}
