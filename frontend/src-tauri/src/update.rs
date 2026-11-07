//! Updating Jay-C itself, the way the Jay-H hub updates the Jay apps (Jay-H's products.rs): the
//! latest GitHub release of TyxMatty/Jay-C, its Windows installer only from that repository's
//! release downloads, checked against the SHA-256 GitHub computes for it, then run. Jay-C exits
//! right away so the installer can replace the running jay-c.exe; the person finishes there.
//!
//! Downloads use WinHTTP (Windows' own HTTP and TLS), not a Rust HTTP client: no TLS stack to ship.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const REPO: &str = "TyxMatty/Jay-C";
/// Jay-C's installer is ~2.3 MB; anything near this is not one.
const MAX_INSTALLER: u64 = 200 * 1024 * 1024;
/// The release JSON (a few KB of notes and assets).
const MAX_JSON: u64 = 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

/// The latest release, for the page to compare with its own version.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    version: String,
    url: String,
    /// It has a Windows installer that can be checked (otherwise there's nothing to install).
    installable: bool,
}

/// The latest release of Jay-C on GitHub, or None when there is none yet.
#[tauri::command]
pub async fn update_latest() -> Result<Option<Latest>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(latest_release()?.map(|release| Latest {
            version: release.tag_name.trim_start_matches(['v', 'V']).to_owned(),
            url: release.html_url.clone(),
            installable: pick_installer(release, REPO).is_ok(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// Downloads the latest installer, checks it and runs it, then closes Jay-C. The release is fetched
/// again here: the page only says "update", never what to download.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("an update is already downloading".into());
    }
    let result = tauri::async_runtime::spawn_blocking(|| {
        let release = latest_release()?.ok_or("there is no release")?;
        let (asset, sha256) = pick_installer(release, REPO)?;
        let bytes = get(&asset.browser_download_url, asset.size)?;
        if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != sha256 {
            return Err(format!("{} doesn't match GitHub's SHA-256; it was not run", asset.name));
        }
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("jay-c-update-{}-{nanos}", std::process::id()));
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&asset.name);
        // shortcut: the folder stays (the installer runs from it); Windows' temp cleanup takes it.
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Command::new(&path).spawn().map(drop).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    BUSY.store(false, Ordering::SeqCst);
    result?;
    app.exit(0);
    Ok(())
}

fn latest_release() -> Result<Option<Release>, String> {
    let (status, body) = request(&format!("https://api.github.com/repos/{REPO}/releases/latest"), MAX_JSON)?;
    match status {
        404 => Ok(None),
        200 => serde_json::from_slice(&body).map(Some).map_err(|e| e.to_string()),
        _ => Err(format!("GitHub {status}")),
    }
}

/// The release's x64 installer and its SHA-256, after Jay-H's checks: from this repository's
/// release downloads, a plain file name, a sane size, and a digest from GitHub.
fn pick_installer(release: Release, repo: &str) -> Result<(Asset, String), String> {
    let asset = release
        .assets
        .into_iter()
        .find(|a| a.name.ends_with("_x64-setup.exe"))
        .ok_or("the latest release has no Windows installer")?;
    if !asset.browser_download_url.starts_with(&format!("https://github.com/{repo}/releases/download/")) {
        return Err(format!("unexpected download address: {}", asset.browser_download_url));
    }
    if asset.name.contains(['/', '\\', ':']) || asset.size > MAX_INSTALLER {
        return Err(format!("unexpected installer: {} ({} bytes)", asset.name, asset.size));
    }
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("the installer has no SHA-256 on GitHub, so it can't be checked")?
        .to_ascii_lowercase();
    Ok((asset, sha256))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// GET that must answer 200, at most `limit` bytes.
fn get(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    match request(url, limit)? {
        (200, body) => Ok(body),
        (status, _) => Err(format!("{url}: HTTP {status}")),
    }
}

/// "https://host/path" → ("host", "/path"). Only HTTPS.
fn split_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("https://")?;
    let slash = rest.find('/').unwrap_or(rest.len());
    let (host, path) = rest.split_at(slash);
    (!host.is_empty() && !host.contains([':', '@'])).then_some((host, if path.is_empty() { "/" } else { path }))
}

/// One HTTPS GET with WinHTTP (system proxy, redirects followed): the status and up to `limit`
/// bytes of body (more is an error).
fn request(url: &str, limit: u64) -> Result<(u32, Vec<u8>), String> {
    use windows::Win32::Networking::WinHttp::*;
    use windows::core::{HSTRING, PCWSTR, w};

    /// Closes a WinHTTP handle when dropped.
    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                let _ = unsafe { WinHttpCloseHandle(self.0) };
            }
        }
    }
    let open = |handle: *mut core::ffi::c_void, what: &str| {
        if handle.is_null() { Err(format!("{what}: {}", windows::core::Error::from_thread().message())) } else { Ok(Handle(handle)) }
    };

    let (host, path) = split_url(url).ok_or_else(|| format!("not an https address: {url}"))?;
    unsafe {
        let session = open(WinHttpOpen(w!("Jay-C"), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0), "WinHttpOpen")?;
        // Resolve, connect, send, receive (ms): a stalled network fails instead of hanging.
        WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 30_000).map_err(|e| e.message())?;
        let connect = open(WinHttpConnect(session.0, &HSTRING::from(host), INTERNET_DEFAULT_HTTPS_PORT, 0), "WinHttpConnect")?;
        let request = open(
            WinHttpOpenRequest(connect.0, w!("GET"), &HSTRING::from(path), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), WINHTTP_FLAG_SECURE),
            "WinHttpOpenRequest",
        )?;
        let headers: Vec<u16> = "Accept: application/vnd.github+json, application/octet-stream".encode_utf16().collect();
        WinHttpAddRequestHeaders(request.0, &headers, WINHTTP_ADDREQ_FLAG_ADD).map_err(|e| e.message())?;
        WinHttpSendRequest(request.0, None, None, 0, 0, 0).map_err(|e| e.message())?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(|e| e.message())?;
        let mut status = 0u32;
        let mut size = 4u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut size,
            std::ptr::null_mut(),
        )
        .map_err(|e| e.message())?;
        let mut body = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            WinHttpReadData(request.0, buf.as_mut_ptr().cast(), buf.len() as u32, &mut read).map_err(|e| e.message())?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&buf[..read as usize]);
            if body.len() as u64 > limit {
                return Err(format!("{url}: bigger than expected"));
            }
        }
        Ok((status, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://github.com/TyxMatty/Jay-C/releases/download/v0.4.0/Jay-C_0.4.0_x64-setup.exe";
    const DIGEST: &str = "sha256:848005e8a2f42200b36f5553fd144a9d8aefdcbddbbf1ad49b56c65f473d63de";

    fn release(url: &str, digest: Option<&str>) -> Release {
        Release {
            tag_name: "v0.4.0".into(),
            html_url: "https://github.com/TyxMatty/Jay-C/releases/tag/v0.4.0".into(),
            assets: vec![Asset { name: "Jay-C_0.4.0_x64-setup.exe".into(), size: 2302415, browser_download_url: url.into(), digest: digest.map(Into::into) }],
        }
    }

    #[test]
    fn pick_installer_checks_address_and_digest() {
        let (asset, sha) = pick_installer(release(URL, Some(DIGEST)), REPO).unwrap();
        assert_eq!(asset.name, "Jay-C_0.4.0_x64-setup.exe");
        assert_eq!(sha, &DIGEST[7..]);
        // Another repository's file, another host, no digest, a malformed digest, no installer.
        assert!(pick_installer(release(URL, Some(DIGEST)), "TyxMatty/Jay-A").is_err());
        assert!(pick_installer(release("https://example.com/TyxMatty/Jay-C/releases/download/x.exe", Some(DIGEST)), REPO).is_err());
        assert!(pick_installer(release(URL, None), REPO).is_err());
        assert!(pick_installer(release(URL, Some("sha256:abc")), REPO).is_err());
        assert!(pick_installer(Release { assets: vec![], ..release(URL, None) }, REPO).is_err());
    }

    #[test]
    fn sha256_and_urls() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(split_url("https://api.github.com/repos/x"), Some(("api.github.com", "/repos/x")));
        assert_eq!(split_url("https://github.com"), Some(("github.com", "/")));
        assert_eq!(split_url("http://github.com/x"), None, "only https");
        assert_eq!(split_url("https://user@evil.com/x"), None);
        assert_eq!(split_url("https://github.com:8443/x"), None);
    }

    /// The real thing, without running the installer: `cargo test update -- --ignored` (downloads
    /// Jay-C's latest installer from GitHub and checks its SHA-256).
    #[test]
    #[ignore]
    fn downloads_and_checks_the_latest_installer() {
        let release = latest_release().unwrap().expect("a release");
        let version = release.tag_name.clone();
        let (asset, sha256) = pick_installer(release, REPO).unwrap();
        let bytes = get(&asset.browser_download_url, asset.size).unwrap();
        assert_eq!(bytes.len() as u64, asset.size);
        assert_eq!(sha256_hex(&bytes), sha256);
        println!("{version}: {} ({} bytes), SHA-256 {sha256} matches", asset.name, bytes.len());
    }
}
