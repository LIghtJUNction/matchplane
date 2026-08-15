# MatchPlane HTTPS deployment

The checked-in Nginx configuration serves the packaged web client, proxies the
marketplace API under `/api/`, and proxies public payment operations under
`/payments-api/`. Payment administrator routes are deliberately unavailable on
the public listener.

`matchplane-bootstrap.conf` provides the HTTP webroot needed for the first ACME
challenge. After Certbot has issued the `matx.tech` certificate, replace it with
`matchplane.conf`.

The repository configuration assumes DNS for `matx.tech` points at the host and
that Certbot stores the certificate under
`/etc/letsencrypt/live/matx.tech/`. Renewal must remain automated; the server
installs a Certbot deploy hook that runs `nginx -t` and reloads Nginx after a
successful renewal.
