use super::service::error;
use crate::Result;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

/// This lock outlives the client, SQLite pool and its entire Tokio runtime.
pub(super) struct Profile {
    _lock: File,
    pub database: String,
}
impl Profile {
    pub fn acquire(root: &Path) -> Result<Self> {
        fs::create_dir_all(root).map_err(|_| error("WHATSAPP_PROFILE_OPEN_FAILED"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))
                .map_err(|_| error("WHATSAPP_PROFILE_PERMISSIONS_FAILED"))?;
        }
        let root = fs::canonicalize(root).map_err(|_| error("WHATSAPP_PROFILE_OPEN_FAILED"))?;
        let database = root.join("store.db");
        if !database.exists() && root.join("creds.json").exists() {
            return Err(error("WHATSAPP_LEGACY_PROFILE_REQUIRES_PAIRING"));
        }
        let lock = open_private(&root.join(".klaus-whatsapp.lock"))?;
        lock.try_lock()
            .map_err(|_| error("WHATSAPP_PROFILE_BUSY"))?;
        open_private(&database)?;
        let database = database
            .to_str()
            .ok_or_else(|| error("WHATSAPP_INVALID_AUTH_DIR"))?;
        // Windows canonicalize uses a verbatim prefix containing '?', which the
        // existing SQLite snapshot parser treats as a URI query delimiter.
        #[cfg(windows)]
        let database = portable_windows_path(database);
        let database = database.to_owned();
        Ok(Self {
            _lock: lock,
            database,
        })
    }
}
#[cfg(any(windows, test))]
fn portable_windows_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    }
}

fn open_private(path: &PathBuf) -> Result<File> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(error("WHATSAPP_PROFILE_INVALID_FILE"));
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| error("WHATSAPP_PROFILE_OPEN_FAILED"))
}

#[cfg(test)]
mod path_tests {
    #[test]
    fn windows_canonical_paths_preserve_the_sqlite_snapshot_destination() {
        assert_eq!(
            super::portable_windows_path(r"\\?\C:\profile\store.db"),
            r"C:\profile\store.db"
        );
        assert_eq!(
            super::portable_windows_path(r"\\?\UNC\host\share\store.db"),
            r"\\host\share\store.db"
        );
        assert_eq!(
            super::portable_windows_path(r"C:\profile\store.db"),
            r"C:\profile\store.db"
        );
    }
}
