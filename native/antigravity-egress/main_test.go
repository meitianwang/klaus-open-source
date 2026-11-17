package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"
)

func selfSignedTLS(t *testing.T, dnsName string) (*tls.Config, *x509.CertPool) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{dnsName},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	return &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h2", "http/1.1"}}, pool
}

func TestAccountPoolsUseIsolatedTLSConnectionsAndStripInternalHeaders(t *testing.T) {
	serverTLS, rootPool := selfSignedTLS(t, "daily-cloudcode-pa.googleapis.com")
	var mu sync.Mutex
	remoteAddrsByAuth := map[string]string{}
	leakedHeaders := []string{}

	upstreamLn, err := tls.Listen("tcp", "127.0.0.1:0", serverTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer upstreamLn.Close()
	upstreamSrv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			remoteAddrsByAuth[r.Header.Get("Authorization")] = r.RemoteAddr
			for _, h := range []string{"X-Egress-Token", "X-Egress-Target", "X-Egress-Pool"} {
				if r.Header.Get(h) != "" {
					leakedHeaders = append(leakedHeaders, h)
				}
			}
			mu.Unlock()
			_, _ = io.WriteString(w, "ok")
		}),
	}
	go func() { _ = upstreamSrv.Serve(upstreamLn) }()
	defer upstreamSrv.Close()

	pools := newClientPool(&tls.Config{RootCAs: rootPool}, upstreamLn.Addr().String(), nil)
	relayLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer relayLn.Close()
	relaySrv := newRelayServer(relayHandler{pools: pools, token: "secret"})
	go func() { _ = relaySrv.Serve(relayLn) }()
	defer relaySrv.Close()

	sendForPool := func(poolKey, auth string) {
		req, err := http.NewRequest("POST", fmt.Sprintf("http://%s/v1internal:loadCodeAssist", relayLn.Addr()), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Egress-Token", "secret")
		req.Header.Set("X-Egress-Target", "daily-cloudcode-pa.googleapis.com")
		req.Header.Set("X-Egress-Pool", poolKey)
		req.Header.Set("Authorization", auth)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("unexpected status %d", resp.StatusCode)
		}
	}

	sendForPool("acct-a", "Bearer token-a")
	sendForPool("acct-b", "Bearer token-b")

	mu.Lock()
	defer mu.Unlock()
	if len(leakedHeaders) > 0 {
		t.Fatalf("relay leaked internal headers: %v", leakedHeaders)
	}
	if remoteAddrsByAuth["Bearer token-a"] == "" || remoteAddrsByAuth["Bearer token-b"] == "" {
		t.Fatalf("missing recorded remote addresses: %v", remoteAddrsByAuth)
	}
	if remoteAddrsByAuth["Bearer token-a"] == remoteAddrsByAuth["Bearer token-b"] {
		t.Fatalf("distinct account pools shared the same upstream connection: %v", remoteAddrsByAuth)
	}
}

func TestH2CBidirectionalStreamingPreservesTrailers(t *testing.T) {
	serverTLS, rootPool := selfSignedTLS(t, "aicode.googleapis.com")
	upstreamLn, err := tls.Listen("tcp", "127.0.0.1:0", serverTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer upstreamLn.Close()

	var upstreamProto http.Protocols
	upstreamProto.SetHTTP2(true)
	upstreamSrv := &http.Server{
		Protocols: &upstreamProto,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ProtoMajor != 2 {
				t.Errorf("expected HTTP/2 upstream, got %s", r.Proto)
			}
			w.Header().Set("Content-Type", "application/grpc")
			w.WriteHeader(200)
			flusher := w.(http.Flusher)
			flusher.Flush()
			buf := make([]byte, 64)
			for {
				n, readErr := r.Body.Read(buf)
				if n > 0 {
					_, _ = w.Write(buf[:n])
					flusher.Flush()
				}
				if readErr == io.EOF {
					break
				}
				if readErr != nil {
					return
				}
			}
			w.Header().Set(http.TrailerPrefix+"Grpc-Status", "0")
		}),
	}
	go func() { _ = upstreamSrv.Serve(upstreamLn) }()
	defer upstreamSrv.Close()

	pools := newClientPool(&tls.Config{RootCAs: rootPool}, upstreamLn.Addr().String(), nil)
	relayLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer relayLn.Close()
	relaySrv := newRelayServer(relayHandler{pools: pools, token: "secret"})
	go func() { _ = relaySrv.Serve(relayLn) }()
	defer relaySrv.Close()

	var h2cProto http.Protocols
	h2cProto.SetUnencryptedHTTP2(true)
	h2cClient := &http.Client{
		Transport: &http.Transport{Protocols: &h2cProto},
	}
	pr, pw := io.Pipe()
	req, err := http.NewRequest("POST", fmt.Sprintf("http://%s/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent", relayLn.Addr()), pr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Egress-Token", "secret")
	req.Header.Set("X-Egress-Target", "aicode.googleapis.com")
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("Te", "trailers")

	go func() {
		_, _ = pw.Write([]byte("chunk-1:"))
		time.Sleep(20 * time.Millisecond)
		_, _ = pw.Write([]byte("chunk-2"))
		_ = pw.Close()
	}()

	resp, err := h2cClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "chunk-1:chunk-2" {
		t.Fatalf("unexpected streamed body %q", string(body))
	}
	if got := resp.Trailer.Get("Grpc-Status"); got != "0" {
		t.Fatalf("expected Grpc-Status trailer 0, got %q (trailers=%v)", got, resp.Trailer)
	}
}

func TestProxyFunctionHonoredUnlessOverrideSet(t *testing.T) {
	called := false
	customProxy := func(_ *http.Request) (*url.URL, error) {
		called = true
		return nil, nil
	}
	_, rootPool := selfSignedTLS(t, "oauth2.googleapis.com")
	pools := newClientPool(&tls.Config{RootCAs: rootPool}, "", customProxy)
	tr := pools.entries
	_ = tr
	client := pools.get("acct")
	if client.Transport.(*http.Transport).Proxy == nil {
		t.Fatal("expected Proxy function to be configured when upstreamOverride is empty")
	}
	overridePools := newClientPool(&tls.Config{RootCAs: rootPool}, "127.0.0.1:9999", customProxy)
	overrideClient := overridePools.get("acct")
	if overrideClient.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("expected Proxy function to be disabled when upstreamOverride is set")
	}
	_ = called
}

func TestHTTP1DownstreamObservesErrorWhenUpstreamStreamAborts(t *testing.T) {
	for _, tc := range []struct {
		name        string
		emitInitial bool
	}{
		{name: "after_partial_sse_frame", emitInitial: true},
		{name: "immediately_after_headers", emitInitial: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			serverTLS, rootPool := selfSignedTLS(t, "daily-cloudcode-pa.googleapis.com")
			upstreamLn, err := tls.Listen("tcp", "127.0.0.1:0", serverTLS)
			if err != nil {
				t.Fatal(err)
			}
			defer upstreamLn.Close()

			var upstreamProto http.Protocols
			upstreamProto.SetHTTP2(true)
			upstreamSrv := &http.Server{
				Protocols: &upstreamProto,
				Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(http.StatusOK)
					flusher := w.(http.Flusher)
					if tc.emitInitial {
						_, _ = io.WriteString(w, "data: {\"partial\":true}\n\n")
					}
					flusher.Flush()
					panic(http.ErrAbortHandler)
				}),
			}
			go func() { _ = upstreamSrv.Serve(upstreamLn) }()
			defer upstreamSrv.Close()

			pools := newClientPool(&tls.Config{RootCAs: rootPool}, upstreamLn.Addr().String(), nil)
			relayLn, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer relayLn.Close()
			relaySrv := newRelayServer(relayHandler{pools: pools, token: "secret"})
			go func() { _ = relaySrv.Serve(relayLn) }()
			defer relaySrv.Close()

			req, err := http.NewRequest("POST", fmt.Sprintf("http://%s/v1internal:streamGenerateContent?alt=sse", relayLn.Addr()), nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Egress-Token", "secret")
			req.Header.Set("X-Egress-Target", "daily-cloudcode-pa.googleapis.com")

			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("expected initial 200 response headers, got error: %v", err)
			}
			defer resp.Body.Close()

			body, readErr := io.ReadAll(resp.Body)
			if readErr == nil {
				t.Fatalf("expected downstream read error when upstream stream aborted, got clean EOF with body %q", string(body))
			}
			if tc.emitInitial && string(body) != "data: {\"partial\":true}\n\n" {
				t.Fatalf("expected flushed partial frame before abort, got %q (err=%v)", string(body), readErr)
			}
		})
	}
}

func TestH2CDownstreamObservesErrorWhenUpstreamStreamAborts(t *testing.T) {
	serverTLS, rootPool := selfSignedTLS(t, "aicode.googleapis.com")
	upstreamLn, err := tls.Listen("tcp", "127.0.0.1:0", serverTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer upstreamLn.Close()

	var upstreamProto http.Protocols
	upstreamProto.SetHTTP2(true)
	upstreamSrv := &http.Server{
		Protocols: &upstreamProto,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/grpc")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "chunk-1")
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}),
	}
	go func() { _ = upstreamSrv.Serve(upstreamLn) }()
	defer upstreamSrv.Close()

	pools := newClientPool(&tls.Config{RootCAs: rootPool}, upstreamLn.Addr().String(), nil)
	relayLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer relayLn.Close()
	relaySrv := newRelayServer(relayHandler{pools: pools, token: "secret"})
	go func() { _ = relaySrv.Serve(relayLn) }()
	defer relaySrv.Close()

	var h2cProto http.Protocols
	h2cProto.SetUnencryptedHTTP2(true)
	h2cClient := &http.Client{
		Transport: &http.Transport{Protocols: &h2cProto},
	}
	req, err := http.NewRequest("POST", fmt.Sprintf("http://%s/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent", relayLn.Addr()), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Egress-Token", "secret")
	req.Header.Set("X-Egress-Target", "aicode.googleapis.com")

	resp, err := h2cClient.Do(req)
	if err != nil {
		t.Fatalf("expected initial 200 response headers, got error: %v", err)
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(resp.Body)
	if readErr == nil {
		t.Fatalf("expected h2c downstream read error when upstream stream aborted, got clean EOF with body %q", string(body))
	}
}
