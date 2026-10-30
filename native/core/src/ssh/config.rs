use crate::{NativeError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONFIG_FILES: usize = 32;
const MAX_INCLUDE_DEPTH: usize = 8;
const MAX_IDENTITIES: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

impl Target {
    pub fn validate(&self) -> Result<()> {
        if self.host.is_empty()
            || self.host.len() > 255
            || !self
                .host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || self.port == Some(0)
            || self.user.as_deref().is_some_and(|s| !valid_user(s))
        {
            return Err(NativeError::new(
                "SSH_INVALID_TARGET",
                "invalid SSH endpoint",
            ));
        }
        Ok(())
    }
}

fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 255
        && !user
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '@')
}

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<PathBuf>,
    pub known_hosts: PathBuf,
    pub agent: Option<PathBuf>,
    pub identities_only: bool,
    pub batch_mode: bool,
    pub accept_new: bool,
}

#[derive(Default)]
struct Values {
    host: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identities: Vec<String>,
    identities_only: Option<bool>,
    batch_mode: Option<bool>,
    accept_new: Option<bool>,
    known_hosts: Option<String>,
    agent: Option<String>,
}

struct Reader<'a> {
    home: &'a Path,
    alias: Option<&'a str>,
    values: Values,
    aliases: HashSet<String>,
    files: usize,
    bytes: usize,
    active_paths: HashSet<PathBuf>,
}

pub fn read_limited(path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(NativeError::new(
                "SSH_FILE_READ_FAILED",
                "an SSH configuration or key file could not be read",
            ))
        }
    };
    let metadata = file
        .metadata()
        .map_err(|_| NativeError::new("SSH_FILE_READ_FAILED", "SSH file metadata unavailable"))?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(NativeError::new(
            "SSH_FILE_LIMIT",
            "SSH input is not a regular file or exceeds its byte limit",
        ));
    }
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeError::new("SSH_FILE_READ_FAILED", "SSH file read failed"))?;
    if bytes.len() > limit {
        return Err(NativeError::new(
            "SSH_FILE_LIMIT",
            "SSH input exceeds its byte limit",
        ));
    }
    Ok(Some(bytes))
}

fn words(line: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '#' if !quoted => break,
            '\\' if chars
                .peek()
                .is_some_and(|c| matches!(c, '"' | '\\' | ' ' | '\t' | '#')) =>
            {
                word.push(chars.next().expect("peeked character"));
                started = true;
            }
            c if !quoted
                && (c.is_whitespace()
                    || c == '=' && (words.is_empty() || words.len() == 1 && !started)) =>
            {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            c => {
                word.push(c);
                started = true;
            }
        }
    }
    if quoted {
        return Err(NativeError::new(
            "SSH_CONFIG_INVALID",
            "unterminated quoted SSH value",
        ));
    }
    if started {
        words.push(word);
    }
    if words.len() > 128 || words.iter().any(|s| s.len() > 4096 || s.contains('\0')) {
        return Err(NativeError::new(
            "SSH_CONFIG_LIMIT",
            "SSH line exceeds its token or length bound",
        ));
    }
    Ok(words)
}

/// Iterative wildcard matching avoids recursive exponential work on a configuration pattern.
pub fn wildcard(pattern: &str, value: &str) -> bool {
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(previous) = star {
            retry += 1;
            v = retry;
            p = previous + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

pub fn patterns_match(patterns: &[String], host: &str) -> bool {
    patterns
        .iter()
        .any(|p| !p.starts_with('!') && wildcard(p, host))
        && !patterns
            .iter()
            .any(|p| p.strip_prefix('!').is_some_and(|p| wildcard(p, host)))
}

fn boolean(value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "yes" => Ok(true),
        "no" => Ok(false),
        _ => Err(NativeError::new("SSH_CONFIG_INVALID", "expected yes or no")),
    }
}

fn expanded(raw: &str, home: &Path, host: &str, user: &str, port: u16) -> Result<PathBuf> {
    let home_text = home
        .to_str()
        .ok_or_else(|| NativeError::new("SSH_PATH_INVALID", "SSH home path is not UTF-8"))?;
    let mut result = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            result.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => result.push('%'),
            Some('d') => result.push_str(home_text),
            Some('h') => result.push_str(host),
            Some('r') => result.push_str(user),
            Some('p') => result.push_str(&port.to_string()),
            _ => {
                return Err(NativeError::new(
                    "SSH_CONFIG_UNSUPPORTED",
                    "unsupported SSH path expansion",
                ))
            }
        }
    }
    if result.contains("${")
        || result.starts_with('~') && !result.starts_with("~/") && result != "~"
    {
        return Err(NativeError::new(
            "SSH_CONFIG_UNSUPPORTED",
            "unsupported SSH home or environment expansion",
        ));
    }
    if result == "~" {
        Ok(home.to_path_buf())
    } else if let Some(rest) = result.strip_prefix("~/") {
        Ok(home.join(rest))
    } else {
        Ok(PathBuf::from(result))
    }
}

impl Reader<'_> {
    fn read(&mut self, path: &Path, depth: usize, applies: &mut bool) -> Result<()> {
        if depth > MAX_INCLUDE_DEPTH || self.files >= MAX_CONFIG_FILES {
            return Err(NativeError::new(
                "SSH_CONFIG_LIMIT",
                "SSH Include depth or file count exceeded",
            ));
        }
        let Some(bytes) = read_limited(path, MAX_FILE_BYTES)? else {
            return Ok(());
        };
        self.files += 1;
        self.bytes += bytes.len();
        if self.bytes > MAX_CONFIG_BYTES {
            return Err(NativeError::new(
                "SSH_CONFIG_LIMIT",
                "SSH configuration byte limit exceeded",
            ));
        }
        let canonical = std::fs::canonicalize(path).map_err(|_| {
            NativeError::new(
                "SSH_FILE_READ_FAILED",
                "SSH configuration path could not be resolved",
            )
        })?;
        if !self.active_paths.insert(canonical.clone()) {
            return Err(NativeError::new("SSH_CONFIG_CYCLE", "cyclic SSH Include"));
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            NativeError::new("SSH_CONFIG_INVALID", "SSH configuration is not UTF-8")
        })?;
        for line in text.lines() {
            let tokens = words(line)?;
            if tokens.is_empty() {
                continue;
            }
            let directive = tokens[0].to_ascii_lowercase();
            let args = &tokens[1..];
            if args.is_empty() {
                return Err(NativeError::new(
                    "SSH_CONFIG_INVALID",
                    "SSH directive has no value",
                ));
            }
            if directive == "host" {
                for alias in args {
                    if !alias.contains(['*', '?']) && !alias.starts_with('!') {
                        self.aliases.insert(alias.clone());
                    }
                }
                *applies = self.alias.is_none_or(|host| patterns_match(args, host));
                continue;
            }
            if directive == "match" {
                if self.alias.is_some() {
                    return Err(NativeError::new(
                        "SSH_CONFIG_UNSUPPORTED",
                        "SSH Match blocks are not supported",
                    ));
                }
                *applies = false;
                continue;
            }
            if directive == "include" && (*applies || self.alias.is_none()) {
                for raw in args {
                    let path = expanded(raw, self.home, self.alias.unwrap_or(""), "", 22)?;
                    let path = if path.is_absolute() {
                        path
                    } else {
                        self.home.join(".ssh").join(path)
                    };
                    let pattern = path.to_str().ok_or_else(|| {
                        NativeError::new("SSH_PATH_INVALID", "SSH Include path is not UTF-8")
                    })?;
                    let mut paths = glob::glob(pattern)
                        .map_err(|_| {
                            NativeError::new("SSH_CONFIG_INVALID", "invalid SSH Include pattern")
                        })?
                        .take(MAX_CONFIG_FILES + 1)
                        .collect::<std::result::Result<Vec<_>, _>>()
                        .map_err(|_| {
                            NativeError::new("SSH_FILE_READ_FAILED", "SSH Include expansion failed")
                        })?;
                    if paths.len() > MAX_CONFIG_FILES {
                        return Err(NativeError::new(
                            "SSH_CONFIG_LIMIT",
                            "SSH Include expansion exceeded its bound",
                        ));
                    }
                    paths.sort();
                    for path in paths {
                        self.read(&path, depth + 1, applies)?;
                    }
                }
                continue;
            }
            if !*applies || self.alias.is_none() {
                continue;
            }
            let first = &args[0];
            match directive.as_str() {
                "hostname" if self.values.host.is_none() => self.values.host = Some(first.clone()),
                "user" if self.values.user.is_none() => self.values.user = Some(first.clone()),
                "port" if self.values.port.is_none() => {
                    self.values.port = Some(
                        first
                            .parse::<u16>()
                            .ok()
                            .filter(|p| *p > 0)
                            .ok_or_else(|| {
                                NativeError::new("SSH_CONFIG_INVALID", "invalid SSH port")
                            })?,
                    )
                }
                "identityfile" => {
                    if self.values.identities.len() >= MAX_IDENTITIES {
                        return Err(NativeError::new(
                            "SSH_CONFIG_LIMIT",
                            "too many SSH identity files",
                        ));
                    }
                    self.values.identities.push(first.clone());
                }
                "identitiesonly" if self.values.identities_only.is_none() => {
                    self.values.identities_only = Some(boolean(first)?)
                }
                "batchmode" if self.values.batch_mode.is_none() => {
                    self.values.batch_mode = Some(boolean(first)?)
                }
                "identityagent" if self.values.agent.is_none() => {
                    self.values.agent = Some(first.clone())
                }
                "userknownhostsfile" if self.values.known_hosts.is_none() => {
                    if args.len() != 1 || first == "none" {
                        return Err(NativeError::new(
                            "SSH_CONFIG_UNSUPPORTED",
                            "one persistent UserKnownHostsFile is required",
                        ));
                    }
                    self.values.known_hosts = Some(first.clone());
                }
                "stricthostkeychecking" if self.values.accept_new.is_none() => {
                    self.values.accept_new = Some(match first.as_str() {
                        "accept-new" => true,
                        "yes" => false,
                        _ => {
                            return Err(NativeError::new(
                                "SSH_CONFIG_UNSUPPORTED",
                                "supported StrictHostKeyChecking values are yes and accept-new",
                            ))
                        }
                    })
                }
                "proxyjump" | "proxycommand" if first != "none" => {
                    return Err(NativeError::new(
                        "SSH_PROXY_UNSUPPORTED",
                        format!("{directive} requires an unsupported proxy transport"),
                    ))
                }
                "certificatefile" | "hostkeyalias" | "canonicalizehostname"
                    if first != "none" && first != "no" =>
                {
                    return Err(NativeError::new(
                        "SSH_CONFIG_UNSUPPORTED",
                        format!("{directive} is not supported by this SSH transport"),
                    ));
                }
                _ => {}
            }
        }
        self.active_paths.remove(&canonical);
        Ok(())
    }
}

pub fn list_hosts(home: &Path) -> Result<Vec<String>> {
    if !home.is_absolute() {
        return Err(NativeError::new(
            "SSH_PATH_INVALID",
            "SSH home must be absolute",
        ));
    }
    let mut reader = Reader {
        home,
        alias: None,
        values: Values::default(),
        aliases: HashSet::new(),
        files: 0,
        bytes: 0,
        active_paths: HashSet::new(),
    };
    reader.read(&home.join(".ssh/config"), 0, &mut true)?;
    let mut hosts: Vec<_> = reader.aliases.into_iter().collect();
    hosts.sort();
    Ok(hosts)
}

pub fn resolve(
    home: &Path,
    local_user: &str,
    default_agent: Option<&Path>,
    target: &Target,
) -> Result<Endpoint> {
    target.validate()?;
    if !home.is_absolute() {
        return Err(NativeError::new(
            "SSH_PATH_INVALID",
            "SSH home must be absolute",
        ));
    }
    let mut reader = Reader {
        home,
        alias: Some(&target.host),
        values: Values::default(),
        aliases: HashSet::new(),
        files: 0,
        bytes: 0,
        active_paths: HashSet::new(),
    };
    reader.read(&home.join(".ssh/config"), 0, &mut true)?;
    let config = reader.values;
    let host = config
        .host
        .unwrap_or_else(|| target.host.clone())
        .replace("%h", &target.host);
    let user = target
        .user
        .clone()
        .or(config.user)
        .unwrap_or_else(|| local_user.to_owned());
    let port = target.port.or(config.port).unwrap_or(22);
    if host.is_empty()
        || host.len() > 255
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
        || !valid_user(&user)
    {
        return Err(NativeError::new(
            "SSH_CONFIG_INVALID",
            "SSH configuration resolved an invalid endpoint",
        ));
    }
    let identities = if config.identities.is_empty() {
        vec![
            "~/.ssh/id_ed25519".into(),
            "~/.ssh/id_ecdsa".into(),
            "~/.ssh/id_rsa".into(),
        ]
    } else {
        config.identities
    };
    let mut identity_files = Vec::new();
    for raw in identities {
        if raw == "none" {
            continue;
        }
        let path = expanded(&raw, home, &host, &user, port)?;
        let path = if path.is_absolute() {
            path
        } else {
            home.join(path)
        };
        if !identity_files.contains(&path) {
            identity_files.push(path);
        }
    }
    let known_hosts = expanded(
        config
            .known_hosts
            .as_deref()
            .unwrap_or("~/.ssh/known_hosts"),
        home,
        &host,
        &user,
        port,
    )?;
    let known_hosts = if known_hosts.is_absolute() {
        known_hosts
    } else {
        home.join(known_hosts)
    };
    let agent = match config.agent.as_deref() {
        Some("none") => None,
        Some("SSH_AUTH_SOCK") | None => default_agent.map(Path::to_path_buf),
        Some(raw) => Some(expanded(raw, home, &host, &user, port)?),
    };
    Ok(Endpoint {
        host,
        port,
        user,
        identity_files,
        known_hosts,
        agent,
        identities_only: config.identities_only.unwrap_or(false),
        batch_mode: config.batch_mode.unwrap_or(false),
        accept_new: config.accept_new.unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str) -> Target {
        Target {
            host: host.into(),
            user: None,
            port: None,
        }
    }

    #[test]
    fn aliases_are_alternatives_and_negation_excludes() {
        let patterns = vec!["alpha".into(), "beta*".into(), "!beta2".into()];
        assert!(patterns_match(&patterns, "alpha"));
        assert!(patterns_match(&patterns, "beta1"));
        assert!(!patterns_match(&patterns, "beta2"));
        assert!(!patterns_match(&["!other".into()], "alpha"));
    }

    #[test]
    fn config_includes_are_ordered_and_first_value_wins() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir_all(ssh.join("config.d")).unwrap();
        std::fs::write(ssh.join("config"), "Host alpha beta\n Include config.d/*\n User fallback\nHost * !gamma\n IdentityFile \"~/.ssh/key space\"\nHost gamma\n ProxyCommand dangerous\n").unwrap();
        std::fs::write(ssh.join("config.d/2"), "User second\n").unwrap();
        std::fs::write(
            ssh.join("config.d/1"),
            "User = first\nHostName=127.0.0.1\nPort 2222\n",
        )
        .unwrap();
        let endpoint = resolve(dir.path(), "local", None, &target("beta")).unwrap();
        assert_eq!(
            (
                endpoint.host.as_str(),
                endpoint.user.as_str(),
                endpoint.port
            ),
            ("127.0.0.1", "first", 2222)
        );
        assert_eq!(endpoint.identity_files, vec![ssh.join("key space")]);
        let explicit = resolve(
            dir.path(),
            "local",
            None,
            &Target {
                host: "alpha".into(),
                user: Some("override".into()),
                port: Some(2200),
            },
        )
        .unwrap();
        assert_eq!((explicit.user.as_str(), explicit.port), ("override", 2200));
        assert_eq!(list_hosts(dir.path()).unwrap(), ["alpha", "beta", "gamma"]);
        assert_eq!(
            resolve(dir.path(), "local", None, &target("gamma"))
                .unwrap_err()
                .code,
            "SSH_PROXY_UNSUPPORTED"
        );
    }

    #[test]
    fn cyclic_and_large_inputs_fail_explicitly() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir(&ssh).unwrap();
        std::fs::write(ssh.join("config"), "Include config\n").unwrap();
        assert_eq!(list_hosts(dir.path()).unwrap_err().code, "SSH_CONFIG_CYCLE");
        std::fs::write(ssh.join("config"), vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(list_hosts(dir.path()).unwrap_err().code, "SSH_FILE_LIMIT");
    }

    #[test]
    fn quotes_comments_and_windows_paths_are_preserved() {
        assert_eq!(
            words("IdentityFile = \"C:\\Users\\me\\key space\" # text").unwrap(),
            ["IdentityFile", "C:\\Users\\me\\key space"]
        );
        assert_eq!(words("User=first").unwrap(), ["User", "first"]);
        assert_eq!(words("Host a b !c").unwrap(), ["Host", "a", "b", "!c"]);
        assert!(words("User \"broken").is_err());
    }
}
