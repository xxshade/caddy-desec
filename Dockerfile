FROM caddy:2.11.8-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/desec


FROM caddy:2.11.8-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
