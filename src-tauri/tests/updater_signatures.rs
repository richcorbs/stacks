//! Real updater check/download/verification with a loopback endpoint, no install
//! or application restart. Fixtures use a disposable key, never the release key.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};
use tauri_plugin_updater::{Config, Error, UpdaterExt};

const PAYLOAD: &[u8] = include_bytes!("fixtures/updater/payload");
const SIGNATURE: &str = include_str!("fixtures/updater/versioned.sig");
const LEGACY: &str = include_str!("fixtures/updater/unversioned.sig");

fn config() -> Value {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let updater: Config = serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
    assert!(
        updater.require_signed_version,
        "Shipping config must enforce signed versions"
    );
    assert_eq!(updater.endpoints.len(), 1);
    assert_eq!(
        updater.endpoints[0].as_str(),
        "https://github.com/richcorbs/stacks/releases/latest/download/latest.json"
    );
    assert!(!updater.allow_downgrades);
    let mut value = config["plugins"]["updater"].clone();
    value["pubkey"] = json!(include_str!("fixtures/updater/public.key").trim());
    value
}

fn download(
    version: &str,
    signature: &str,
    bytes: &[u8],
    expected_update: bool,
) -> Result<Vec<u8>, Error> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let manifest = json!({
        "version": version,
        "platforms": { "test-target": {
            "url": format!("{endpoint}/artifact"), "signature": signature.trim()
        }}
    });
    let mut responses = vec![manifest.to_string().into_bytes()];
    if expected_update {
        responses.push(bytes.to_vec());
    }
    let server = thread::spawn(move || {
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "Updater request timed out");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", response.len()).unwrap();
            socket.write_all(&response).unwrap();
        }
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), config());
    context.package_info_mut().version = "0.5.92".parse().unwrap();
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .target("test-target")
        .executable_path("test-runtime/Stacks")
        .endpoints(vec![endpoint.parse().unwrap()])
        .unwrap()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .unwrap();
    let result = tauri::async_runtime::block_on(async {
        let update = updater.check().await?;
        assert_eq!(update.is_some(), expected_update);
        match update {
            Some(update) => {
                // install rechecks the same signature before touching disk.
                assert!(update.install(b"tampered").is_err());
                update.download(|_, _| {}, || {}).await
            }
            None => Ok(Vec::new()),
        }
    });
    server.join().unwrap();
    result
}

/// Opt-in check of a real locally built archive with the shipping public key.
/// STACKS_TEST_UPDATER_ARCHIVE=/absolute/path/Stacks.app.tar.gz cargo test
///   --test updater_signatures local_release_artifact -- --ignored
#[test]
#[ignore = "requires a locally signed release archive; never installs or restarts"]
fn local_release_artifact() {
    let archive =
        std::env::var("STACKS_TEST_UPDATER_ARCHIVE").expect("Set STACKS_TEST_UPDATER_ARCHIVE");
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), config["plugins"]["updater"].clone());
    context.package_info_mut().version = "0.0.0".parse().unwrap();
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .target("test-target")
        .executable_path("test-runtime/Stacks")
        .build()
        .unwrap();
    let signature = std::fs::read_to_string(format!("{archive}.sig")).unwrap();
    let mut metadata = json!({
        "version": config["version"],
        "platforms": { "test-target": {
            "url": "https://example.invalid/artifact", "signature": signature.trim()
        }}
    });
    let bytes = std::fs::read(archive).unwrap();
    let update = updater.restore_update(metadata.clone()).unwrap().unwrap();
    update.verify(&bytes).unwrap();
    let mut tampered = bytes.clone();
    tampered[0] ^= 1;
    assert!(update.verify(&tampered).is_err());
    metadata["version"] = json!("99.0.1");
    assert!(matches!(
        updater
            .restore_update(metadata)
            .unwrap()
            .unwrap()
            .verify(&bytes),
        Err(Error::SignedVersionMismatch { .. })
    ));
}

#[test]
fn valid_signed_version_downloads() {
    assert_eq!(
        download("99.0.0", SIGNATURE, PAYLOAD, true).unwrap(),
        PAYLOAD
    );
}

#[test]
fn announced_version_must_match_authenticated_version() {
    assert!(matches!(
        download("99.0.1", SIGNATURE, PAYLOAD, true),
        Err(Error::SignedVersionMismatch { .. })
    ));
}

#[test]
fn missing_version_is_rejected_even_with_a_valid_legacy_signature() {
    assert!(matches!(
        download("99.0.0", LEGACY, PAYLOAD, true),
        Err(Error::MissingSignedVersion)
    ));
}

#[test]
fn tampered_artifact_is_rejected() {
    assert!(matches!(
        download("99.0.0", SIGNATURE, b"tampered", true),
        Err(Error::Minisign(_))
    ));
}

#[test]
fn old_unversioned_releases_are_not_download_candidates() {
    assert!(download("0.5.91", LEGACY, PAYLOAD, false)
        .unwrap()
        .is_empty());
}
