use klaus_native_core::ssh::fixture::Fixture;

fn main() {
    let root = std::path::PathBuf::from(std::env::args_os().nth(1).expect("fixture output directory"));
    assert!(root.is_absolute(), "fixture output directory must be absolute");
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        std::fs::create_dir_all(&root).unwrap();
        let fixture = Fixture::start(Some(root.join("audit.json"))).await;
        fixture.write_info(&root);
        println!("SSH fixture ready on loopback port {}", fixture.port);
        std::future::pending::<()>().await;
    });
}
