# Local TLS test fixture

`localhost-test.crt` and `localhost-test.key` are a deliberately public, self-signed localhost test pair. They were generated for the in-process HTTPS regression and are not a production credential. The test never installs them into the OS keychain and restores Node default trust before it ends.
