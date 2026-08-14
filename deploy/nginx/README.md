# Bare-IP HTTPS deployment

The checked-in Nginx configuration serves the packaged web client, proxies the
marketplace API under `/api/`, and proxies public payment operations under
`/payments-api/`. Payment administrator routes are deliberately unavailable on
the public listener.

`matchplane-bootstrap.conf` provides the HTTP webroot needed for the first ACME
challenge. After Certbot 5.4 or newer has issued the IP certificate, replace it
with `matchplane.conf`.

IP certificates use Let's Encrypt's `shortlived` profile and are valid for about
six days. Renewal must remain automated. The server installs a Certbot deploy
hook that runs `nginx -t` and reloads Nginx after a successful renewal.
