# Native Prisma TLS transport

The central and provider database lifecycles own the URL passed to Prisma's
native query engine. Provider registry metadata and destination policies retain
`sslmode=verify-full`. At this driver boundary only, that setting becomes
`sslmode=require&sslaccept=strict`, which requires encryption, trusted certificates,
and a matching server identity.

Prisma 6.19.3 otherwise interprets `verify-full` as its default `prefer`, allowing
plaintext after TLS refusal, and defaults to accepting invalid certificates.
The pinned [native URL parser](https://github.com/prisma/prisma-engines/blob/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/quaint/src/connector/postgres/url.rs)
defines these settings. This transport conversion is owned by the database
package and must be re-evaluated when replacing the native engine; remove it
once the replacement directly enforces the configured verification policy.

The control-plane advisory lock uses the separate `pg` driver and an unpooled
connection. Its `verify-full` URL is passed through unchanged. The Prisma
conversion must never be applied to that driver or to provider registry rows.

| Acceptance scenario | Coverage |
| --- | --- |
| Given `verify-full`, when TLS is refused, neither native client sends plaintext startup or authentication | Automated: `packages/database/src/native-prisma-tls.integration.test.ts` |
| Given an untrusted or mismatched certificate, both native clients reject it before startup | Automated: `packages/database/src/native-prisma-tls.integration.test.ts` |
| Given a trusted certificate matching the target, both clients complete TLS and send encrypted startup | Automated: `packages/database/src/native-prisma-tls.integration.test.ts` |
| Given ambiguous, contradictory, unsupported TLS settings, fail without exposing credentials | Automated: `packages/database/src/native-prisma-tls.test.ts` |
| Given supported local settings or unrelated URL parameters, preserve their behavior | Automated: `packages/database/src/native-prisma-tls.test.ts` |

The integration fixture binds only loopback, generates temporary synthetic
certificates, and stops at startup with an authentication refusal. It never uses
application credentials or connects to an actual database.
