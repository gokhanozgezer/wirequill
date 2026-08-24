# Test certificate

A self-signed certificate and private key, generated once for the HTTPS proxy
tests. It exists so a test can start a TLS server on `127.0.0.1` and check that
WireQuill forwards to an HTTPS target correctly, including with `--insecure`.

```text
subject  CN=localhost, O=WireQuill Test Fixture
SAN      DNS:localhost, IP:127.0.0.1
issuer   itself
```

**This key is public on purpose and protects nothing.** It is committed so the
test suite runs without a generation step, it is trusted by nothing, and it is
valid only for a name that resolves to the machine running the test. A secret
scanner flagging it has done its job; the answer is that there is no secret
here.

Nothing in WireQuill uses it outside `test/integration/proxy-tls.test.ts`.
