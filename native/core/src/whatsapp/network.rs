#[cfg(feature = "whatsapp-fixtures")]
use super::service::error;
use super::service::Shared;
#[cfg(feature = "whatsapp-fixtures")]
use crate::Result as NativeResult;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use rustls_platform_verifier::BuilderVerifierExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_websockets::{ClientBuilder, Connector, Limits, Message};
use wacore::net::{
    HttpClient, HttpRequest, HttpResponse, StreamingHttpResponse, Transport, TransportEvent,
    TransportFactory, WHATSAPP_WEB_WS_URL,
};

#[derive(Clone)]
pub(super) struct Endpoints {
    base: Option<String>,
}
impl Endpoints {
    pub fn production() -> Self {
        Self { base: None }
    }
    #[cfg(feature = "whatsapp-fixtures")]
    pub fn fixture(base: &str) -> NativeResult<Self> {
        let url =
            reqwest::Url::parse(base).map_err(|_| error("WHATSAPP_INVALID_FIXTURE_ENDPOINT"))?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(error("WHATSAPP_INVALID_FIXTURE_ENDPOINT"));
        }
        Ok(Self {
            base: Some(url.as_str().trim_end_matches('/').to_owned()),
        })
    }
    fn websocket(&self) -> String {
        self.base
            .as_ref()
            .map(|base| format!("{}/ws/chat", base.replacen("http:", "ws:", 1)))
            .unwrap_or_else(|| WHATSAPP_WEB_WS_URL.into())
    }
    fn http(&self, url: &str) -> Result<reqwest::Url> {
        let parsed = reqwest::Url::parse(url)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(anyhow!("WHATSAPP_HTTP_URL_INVALID"));
        }
        if let Some(base) = &self.base {
            // A fixture has no external network capability, including redirects and media hosts.
            if parsed.host_str() != Some("web.whatsapp.com") {
                return Err(anyhow!("WHATSAPP_FIXTURE_EXTERNAL_REQUEST_REFUSED"));
            }
            return Ok(reqwest::Url::parse(&format!("{}{}", base, parsed.path()))?);
        }
        Ok(parsed)
    }
}
fn tls() -> Result<rustls::ClientConfig> {
    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_platform_verifier()?
    .with_no_client_auth())
}
#[derive(Clone)]
pub(super) struct Http {
    client: reqwest::Client,
    shared: Arc<Shared>,
    endpoints: Endpoints,
    runtime: tokio::runtime::Handle,
}
impl Http {
    pub fn new(shared: Arc<Shared>, endpoints: Endpoints) -> Result<Self> {
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls()?)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            client,
            shared,
            endpoints,
            runtime: tokio::runtime::Handle::current(),
        })
    }
    async fn response(&self, request: HttpRequest, limit: usize) -> Result<HttpResponse> {
        if request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > 32 * 1024 * 1024)
        {
            return Err(anyhow!("WHATSAPP_HTTP_BODY_LIMIT"));
        }
        let url = self.endpoints.http(&request.url)?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes())?;
        let mut builder = self.client.request(method, url);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let operation = async {
            let mut response = builder.send().await?;
            let status_code = response.status().as_u16();
            if response
                .content_length()
                .is_some_and(|bytes| bytes > limit as u64)
            {
                return Err(anyhow!("WHATSAPP_HTTP_BODY_LIMIT"));
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if body.len() + chunk.len() > limit {
                    return Err(anyhow!("WHATSAPP_HTTP_BODY_LIMIT"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpResponse { status_code, body })
        };
        tokio::select! {biased;_=self.shared.cancelled()=>Err(anyhow!("CLOSED")),result=operation=>result}
    }
}
#[async_trait]
impl HttpClient for Http {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse> {
        let result = self.response(request, 16 * 1024 * 1024).await;
        if (result.is_err()
            || result
                .as_ref()
                .is_ok_and(|response| response.status_code >= 400))
            && !self.shared.is_closing()
        {
            self.shared
                .publish(serde_json::json!({"kind":"networkError","stage":"http"}));
        }
        result.map_err(|_| anyhow!("WHATSAPP_HTTP_FAILED"))
    }
    fn execute_streaming(&self, request: HttpRequest) -> Result<StreamingHttpResponse> {
        // The protocol calls this on a blocking worker. Cancellation also interrupts that worker's HTTP wait.
        let response = self
            .runtime
            .block_on(self.response(request, 64 * 1024 * 1024))
            .map_err(|_| anyhow!("WHATSAPP_HTTP_FAILED"))?;
        Ok(StreamingHttpResponse {
            status_code: response.status_code,
            body: Box::new(std::io::Cursor::new(response.body)),
        })
    }
}
type Raw =
    tokio_websockets::WebSocketStream<tokio_websockets::MaybeTlsStream<tokio::net::TcpStream>>;
struct Socket {
    sink: Mutex<Option<futures_util::stream::SplitSink<Raw, Message>>>,
    stop: tokio::sync::watch::Sender<bool>,
    shared: Arc<Shared>,
}
#[async_trait]
impl Transport for Socket {
    async fn send(&self, data: Vec<u8>) -> Result<()> {
        if data.len() > 16 * 1024 * 1024 {
            return Err(anyhow!("WHATSAPP_FRAME_LIMIT"));
        }
        tokio::select! {biased;_=self.shared.cancelled()=>Err(anyhow!("CLOSED")),result=async{
            let mut guard=self.sink.lock().await;let sink=guard.as_mut().ok_or_else(||anyhow!("WHATSAPP_SOCKET_CLOSED"))?;
            tokio::time::timeout(Duration::from_secs(15),sink.send(Message::binary(data))).await??;Ok(())
        }=>result}
    }
    async fn disconnect(&self) {
        self.stop.send_replace(true);
        let operation = async {
            if let Some(mut sink) = self.sink.lock().await.take() {
                let _ = sink
                    .send(Message::close(
                        Some(tokio_websockets::CloseCode::NORMAL_CLOSURE),
                        "",
                    ))
                    .await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), operation).await;
    }
}
pub(super) struct Factory {
    shared: Arc<Shared>,
    endpoints: Endpoints,
}
impl Factory {
    pub fn new(shared: Arc<Shared>, endpoints: Endpoints) -> Self {
        Self { shared, endpoints }
    }
}
#[async_trait]
impl TransportFactory for Factory {
    async fn create_transport(
        &self,
    ) -> Result<(Arc<dyn Transport>, async_channel::Receiver<TransportEvent>)> {
        let connect = async {
            let connector = Connector::Rustls(tokio_rustls::TlsConnector::from(Arc::new(tls()?)));
            let uri = self.endpoints.websocket().parse()?;
            let (socket, _) = ClientBuilder::from_uri(uri)
                .connector(&connector)
                .limits(Limits::default().max_payload_len(Some(16 * 1024 * 1024)))
                .connect()
                .await?;
            Ok::<_, anyhow::Error>(socket)
        };
        let socket = tokio::select! {biased;_=self.shared.cancelled()=>return Err(anyhow!("CLOSED")),result=tokio::time::timeout(Duration::from_secs(15),connect)=>result};
        let socket = match socket {
            Ok(Ok(socket)) => socket,
            _ => {
                self.shared
                    .publish(serde_json::json!({"kind":"networkError","stage":"websocket"}));
                return Err(anyhow!("WHATSAPP_CONNECT_FAILED"));
            }
        };
        let (sink, mut stream) = socket.split();
        let (send, receive) = async_channel::bounded(4);
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let transport = Arc::new(Socket {
            sink: Mutex::new(Some(sink)),
            stop,
            shared: Arc::clone(&self.shared),
        });
        let shared = Arc::clone(&self.shared);
        send.try_send(TransportEvent::Connected)?;
        tokio::spawn(async move {
            loop {
                tokio::select! {biased;
                    _=shared.cancelled()=>break,
                    _=stopped.changed()=>break,
                    next=stream.next()=>match next {
                        Some(Ok(message)) if message.is_binary()=>{
                            let data=TransportEvent::DataReceived(bytes::Bytes::from(message.into_payload()));
                            tokio::select!{biased;_=shared.cancelled()=>break,_=stopped.changed()=>break,result=send.send(data)=>{if result.is_err(){break;}}}
                        },
                        Some(Ok(message)) if !message.is_close()=>{},
                        _=>break,
                    }
                }
            }
            // Closing this sender is authoritative even if the bounded queue cannot accept the final marker.
            let _ = send.try_send(TransportEvent::Disconnected);
        });
        Ok((transport, receive))
    }
}
