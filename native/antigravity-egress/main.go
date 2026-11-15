// Command antigravity-egress is a local relay for Klaus engine traffic bound
// for the Antigravity service. The engine speaks plain HTTP over loopback;
// the relay re-issues each request over its own TLS stack to the allowlisted
// upstream host named by the X-Egress-Target header, so upstream connections
// originate from the same HTTP/TLS stack that the hub protocol components
// use. Responses stream back with per-chunk flushing so server-sent event
// streams stay live.
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
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var allowedTargets = map[string]bool{
	"daily-cloudcode-pa.googleapis.com": true,
	"cloudcode-pa.googleapis.com":       true,
	"oauth2.googleapis.com":             true,
}

// Hop-by-hop and relay-internal headers must not be forwarded in either
// direction.
var skipRequestHeaders = map[string]bool{
	"host":              true,
	"connection":        true,
	"keep-alive":        true,
	"proxy-connection":  true,
	"transfer-encoding": true,
	"x-egress-token":    true,
	"x-egress-target":   true,
	"content-length":    true,
}

var skipResponseHeaders = map[string]bool{
	"connection":        true,
	"keep-alive":        true,
	"transfer-encoding": true,
}

func main() {
	log.SetFlags(0)
	token := os.Getenv("KLAUS_EGRESS_TOKEN")
	if token == "" {
		// Alternative secret-file provisioning, mirroring the common
		// container secret-mount pattern.
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
	// Diagnostic CA injection for local wire-fidelity harnesses; production
	// runs use the platform trust store.
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

	transport := &http.Transport{
		TLSClientConfig:   tlsConfig,
		ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// Diagnostic override used by local wire-fidelity harnesses.
			if override := os.Getenv("KLAUS_EGRESS_UPSTREAM_OVERRIDE"); override != "" {
				addr = override
			}
			dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
			return dialer.DialContext(ctx, network, addr)
		},
		MaxIdleConnsPerHost: 4,
	}
	client := &http.Client{Transport: transport}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("antigravity-egress: listen: %v", err)
	}
	server := &http.Server{
		Handler:           relayHandler{client: client, token: token},
		ReadHeaderTimeout: 10 * time.Second,
	}

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
	client *http.Client
	token  string
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
	target := strings.ToLower(r.Header.Get("X-Egress-Target"))
	if !allowedTargets[target] {
		http.Error(w, "unknown egress target", http.StatusBadRequest)
		return
	}
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
		if skipRequestHeaders[strings.ToLower(name)] {
			continue
		}
		for _, value := range values {
			out.Header.Add(name, value)
		}
	}
	out.ContentLength = r.ContentLength

	resp, err := h.client.Do(out)
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
			}
			return
		}
	}
}
