fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(klaus_native_core::whatsapp::fixture::run())
}
