# PostgreSQL backup gate

This gate creates a local, verified backup of the `matchplane` database before an
operator runs a production migration. It does **not** restore a database and it
does not replace an encrypted, off-host backup.

## Security contract

- `/var/backups/matchplane/postgres` is prepared by root as
  `postgres:postgres` mode `0700`.
- `matchplane-postgres-backup.service` runs as `User=postgres`, uses
  `UMask=0077`, and can connect only through the PostgreSQL Unix socket at
  `/run/postgresql`. The command fixes the database and database user to
  `matchplane` and `postgres`, uses `--no-password`, and clears inherited libpq
  settings. No database URL or password is accepted.
- The service has no IP address family, no writable path except the backup
  directory, and uses a read-only view of the PostgreSQL socket directory.
- Archives use PostgreSQL custom format. A backup is published only after
  `pg_restore --list` succeeds. Each archive has an adjacent SHA-256 sidecar.
- The backup and verifier reject a non-canonical backup directory and reject
  managed entries that are symlinks, hardlinks, non-regular files, have the
  wrong owner/mode, or do not match the exact filename grammar.
- Journal output is bounded to a file basename, byte count, elapsed seconds, and
  a non-sensitive stage/status. PostgreSQL output is not copied to the journal.

Archives are named:

```text
matchplane-postgres-YYYYMMDDTHHMMSSZ-XXXXXXXXXXXX.dump
matchplane-postgres-YYYYMMDDTHHMMSSZ-XXXXXXXXXXXX.dump.sha256
```

Temporary files are created in the same directory. An exclusive `flock` on the
directory prevents concurrent dumps; data and directory metadata are synced
around atomic renames. Exit traps remove unpublished fragments.

## Install and explicitly enable in production

Packages install the scripts, service, and timer but deliberately leave the
timer disabled. The test-only `deploy/scripts/configure-ubuntu-host.sh` prepares
the directory but never enables the timer.

On a production host with the local PostgreSQL cluster already configured for
peer authentication, an operator can opt in explicitly:

```sh
sudo matchplane-postgres-backup-prepare
sudo systemctl daemon-reload
sudo systemctl start matchplane-postgres-backup.service
sudo systemctl enable --now matchplane-postgres-backup.timer
sudo matchplane-postgres-backup-verify
```

The timer runs daily at 03:15 UTC with a stable randomized delay of up to 45
minutes and `Persistent=true`. Package installation, development setup, and
package upgrade do not enable it or run a backup.

The only supported setting is the retention window in
`/etc/matchplane/postgres-backup.conf`:

```ini
MATCHPLANE_POSTGRES_BACKUP_RETENTION_DAYS=14
```

The accepted range is 1 through 3650 days. Retention examines only exact managed
archive/sidecar names. Unexpected names are never deleted. A managed symlink,
hardlink, or unsafe file causes the run to fail closed.

## Migration gate

Run the verifier as root immediately before a production migration:

```sh
sudo matchplane-postgres-backup-verify && sudo matchplane migrate
```

The verifier is read-only. It takes a shared lock and requires all of the
following:

1. the timer is enabled and active;
2. the backup service has completed at least once and its last result is
   successful;
3. a latest strict-format archive and sidecar exist with safe metadata;
4. the SHA-256 sidecar names that archive and matches its bytes; and
5. `pg_restore --list` accepts the archive.

Any failed check returns a non-zero exit code and blocks the chained migration.
The verifier never invokes `pg_restore` in restore mode. Recovery remains a
separate, operator-reviewed procedure that must be rehearsed outside production
before it is needed.
