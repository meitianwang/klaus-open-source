// Command antigravity-egress is a local relay for Klaus engine traffic bound
// for the Antigravity service. The engine speaks plain HTTP/1.1 or unencrypted
// HTTP/2 (h2c) over loopback; the relay re-issues each request over its own TLS
// stack to the allowlisted upstream host named by the X-Egress-Target header.
// Responses stream back with per-chunk flushing and trailer preservation so
// both server-sent event streams and bidirectional gRPC streams stay live.
//
// Lifecycle: the relay prints "READY 127.0.0.1:<port>" once listening, exits
// when its stdin closes (the parent process is gone) or on SIGINT/SIGTERM.
// Every request must carry the shared secret from KLAUS_EGRESS_TOKEN.
package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxAccountPools = 16

var allowedTargets = map[string]bool{
	"daily-cloudcode-pa.googleapis.com": true,
	"cloudcode-pa.googleapis.com":       true,
	"oauth2.googleapis.com":             true,
	"aicode.googleapis.com":             true,
	"www.googleapis.com":                true,
}

// Only explicit protocol headers emitted by Cloud Code / gRPC requests are
// forwarded upstream. Relay-internal headers and HTTP library defaults such as
// "Accept: */*" are dropped so net/http's Transport manages Host,
// Content-Length, and Accept-Encoding natively. "te: trailers" is preserved
// separately for gRPC over HTTP/2.
var allowedRequestHeaders = map[string]bool{
	"authorization": true,
	"content-type":  true,
	"user-agent":    true,
	"grpc-timeout":  true,
}

var skipResponseHeaders = map[string]bool{
	"connection":        true,
	"keep-alive":        true,
	"transfer-encoding": true,
}

type poolEntry struct {
	key       string
	client    *http.Client
	transport *http.Transport
}

type clientPool struct {
	mu      sync.Mutex
	factory func() (*http.Client, *http.Transport)
	entries []poolEntry
}

func newClientPool(tlsBase *tls.Config, upstreamOverride string, proxyFunc func(*http.Request) (*url.URL, error)) *clientPool {
	return &clientPool{
		factory: func() (*http.Client, *http.Transport) {
			var clonedTLS *tls.Config
			if tlsBase != nil {
				clonedTLS = tlsBase.Clone()
			} else {
				clonedTLS = &tls.Config{}
			}
			activeProxy := proxyFunc
			if upstreamOverride != "" {
				activeProxy = nil
			}
			transport := &http.Transport{
				Proxy:             activeProxy,
				TLSClientConfig:   clonedTLS,
				ForceAttemptHTTP2: true,
				DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
					if upstreamOverride != "" {
						addr = upstreamOverride
					}
					dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
					return dialer.DialContext(ctx, network, addr)
				},
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     90 * time.Second,
			}
			return &http.Client{Transport: transport}, transport
		},
	}
}

func (p *clientPool) get(rawKey string) *http.Client {
	key := strings.TrimSpace(rawKey)
	if len(key) > 128 {
		key = key[:128]
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, entry := range p.entries {
		if entry.key == key {
			if i != len(p.entries)-1 {
				p.entries = append(append(p.entries[:i], p.entries[i+1:]...), entry)
			}
			return entry.client
		}
	}
	if len(p.entries) >= maxAccountPools {
		evicted := p.entries[0]
		p.entries = p.entries[1:]
		evicted.transport.CloseIdleConnections()
	}
	client, transport := p.factory()
	p.entries = append(p.entries, poolEntry{key: key, client: client, transport: transport})
	return client
}

func (p *clientPool) reset(rawKey string) {
	key := strings.TrimSpace(rawKey)
	p.mu.Lock()
	defer p.mu.Unlock()
	if key == "" {
		for _, entry := range p.entries {
			entry.transport.CloseIdleConnections()
		}
		p.entries = nil
		return
	}
	for i, entry := range p.entries {
		if entry.key == key {
			entry.transport.CloseIdleConnections()
			p.entries = append(p.entries[:i], p.entries[i+1:]...)
			return
		}
	}
}

func newRelayServer(handler http.Handler) *http.Server {
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		Protocols:         &protocols,
	}
}

func main() {
	log.SetFlags(0)
	token := os.Getenv("KLAUS_EGRESS_TOKEN")
	if token == "" {
		if tokenFile := os.Getenv("KLAUS_EGRESS_TOKEN_FILE"); tokenFile != "" {
			if contents, err := os.ReadFile(tokenFile); err == nil {
				token = strings.TrimSpace(string(contents))
			}
		}
	}
	if token == "" {
		log.Fatal("antigravity-egress: KLAUS_EGRESS_TOKEN or KLAUS_EGRESS_TOKEN_FILE is required")
	}

	tlsConfig := &tls.Config{}
	if caFile := os.Getenv("KLAUS_EGRESS_CA_FILE"); caFile != "" {
		pemBytes, err := os.ReadFile(caFile)
		if err != nil {
			log.Fatalf("antigravity-egress: read CA file: %v", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			log.Fatal("antigravity-egress: CA file contains no certificates")
		}
		tlsConfig.RootCAs = pool
	}

	pools := newClientPool(tlsConfig, os.Getenv("KLAUS_EGRESS_UPSTREAM_OVERRIDE"), http.ProxyFromEnvironment)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("antigravity-egress: listen: %v", err)
	}
	server := newRelayServer(relayHandler{pools: pools, token: token})

	fmt.Fprintf(os.Stdout, "READY 127.0.0.1:%d\n", listener.Addr().(*net.TCPAddr).Port)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		// Parent process death closes our stdin; never outlive the parent.
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = server.Close()
	}()
	go func() {
		<-stop
		_ = server.Close()
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatalf("antigravity-egress: serve: %v", err)
	}
}

type relayHandler struct {
	pools *clientPool
	token string
}

func (h relayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	got := r.Header.Get("X-Egress-Token")
	if subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/egress-healthz" {
		_, _ = io.WriteString(w, "ok")
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/egress-reset-pool" {
		h.pools.reset(r.Header.Get("X-Egress-Pool"))
		_, _ = io.WriteString(w, "ok")
		return
	}
	target := strings.ToLower(r.Header.Get("X-Egress-Target"))
	hostOnly := target
	if host, _, err := net.SplitHostPort(target); err == nil {
		hostOnly = host
	}
	if !allowedTargets[hostOnly] {
		http.Error(w, "unknown egress target", http.StatusBadRequest)
		return
	}
	_ = http.NewResponseController(w).EnableFullDuplex()

	upstream := "https://" + target + r.URL.Path
	if r.URL.RawQuery != "" {
		upstream += "?" + r.URL.RawQuery
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, upstream, r.Body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	for name, values := range r.Header {
		lower := strings.ToLower(name)
		if lower == "te" {
			for _, value := range values {
				if strings.EqualFold(strings.TrimSpace(value), "trailers") {
					out.Header.Add("Te", "trailers")
				}
			}
			continue
		}
		if !allowedRequestHeaders[lower] {
			continue
		}
		for _, value := range values {
			out.Header.Add(name, value)
		}
	}
	out.ContentLength = r.ContentLength

	client := h.pools.get(r.Header.Get("X-Egress-Pool"))
	resp, err := client.Do(out)
	if err != nil {
		log.Printf("antigravity-egress: upstream %s %s: %v", r.Method, target, err)
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for name, values := range resp.Header {
		if skipResponseHeaders[strings.ToLower(name)] {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := resp.Body.Read(buffer)
		if count > 0 {
			if _, writeErr := w.Write(buffer[:count]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				log.Printf("antigravity-egress: upstream read: %v", readErr)
				// Abort the downstream response instead of returning normally so
				// net/http neither appends a terminal HTTP/1.1 zero-length chunk
				// nor closes an h2c stream cleanly when the upstream stream broke.
				panic(http.ErrAbortHandler)
			}
			break
		}
	}
	for name, values := range resp.Trailer {
		for _, value := range values {
			w.Header().Add(http.TrailerPrefix+name, value)
		}
	}
}
