# Persistent platform-router state

The Web control plane owns `/etc/matchplane/secrets/root-email`. This directory contains the
current-generation pointer, immutable generation JSON, audit-delivery state, and referenced
provider credential slots. It is secret-bearing durable state, not cache data: a restart must not
replace it with an empty directory, and it must never be mounted by gateway, payment, workers, or
builder workloads.

## Filesystem contract

The mount root is `root:matchplane-web` with mode `0770` on packaged hosts. In Compose and
Kubernetes, the numeric Web group is the equivalent owner. Web creates `generations/` at `0750`
and creates generation, pointer, audit, and credential files at `0640`. Bootstrap processes repair
only the mount-root owner and mode; they do not pre-create, truncate, copy, or sweep state files.
Credential-shaped temporary files are not age-cleaned by tmpfiles or a systemd timer. Transaction
recovery and bounded garbage collection remain application-owned.

## Docker Compose

The `web` service has one read-write bind mount at the exact target
`/etc/matchplane/secrets/root-email`. Its default source is the stable repository data directory
`var/platform-router-state`; override it with an absolute
`MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT` when state lives on an operator-managed disk.

Before the first start, and after changing the source path, prepare the directory for the `node`
identity in the pinned Web image:

```sh
sudo deploy/scripts/prepare-compose-router-state.sh
# Override only when the image/runtime uses different numeric IDs:
sudo MATCHPLANE_COMPOSE_WEB_UID=1000 MATCHPLANE_COMPOSE_WEB_GID=1000 \
  MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT=/srv/matchplane/platform-router-state \
  deploy/scripts/prepare-compose-router-state.sh
```

The script preserves every existing child. Back up the directory as one filesystem-consistent
unit. To restore, stop Web, restore the complete directory (including the current pointer and all
referenced generations/credentials), run the preparation script, validate the mount, and only then
start Web. Never restore only the pointer or only a credential file.

## Helm/Kubernetes

`web.platformRouterStorage` is mandatory. With no `existingClaim`, the chart creates a PVC from
`storageClass`, `size`, and `accessModes`; with `existingClaim`, it mounts that pre-provisioned PVC
and creates no claim. The claim is mounted read-write only by Web. The Web pod keeps its read-only
root filesystem. A short-lived init container repairs the PVC root to `root:<pod fsGroup>` mode
`0770`; the long-lived Web container remains non-root with all capabilities dropped.

For the default two Web replicas, storage must support `ReadWriteMany` and POSIX `chown`, `chmod`,
atomic rename, directory `fsync`, stable inode identity, and coherent cross-node reads. The chart
rejects replicas greater than one unless `accessModes` includes `ReadWriteMany`. A single replica
may use `ReadWriteOnce`. Confirm the selected CSI driver actually supplies those semantics; an
access-mode label alone is
not proof. This PVC is distinct from `runtime.existingWebSecret`: Kubernetes Secrets bootstrap
service credentials, while this PVC stores mutable generation history and credential slots.

Example with an existing claim:

```yaml
web:
  replicas: 2
  platformRouterStorage:
    enabled: true
    existingClaim: matchplane-router-state-rwx
    storageClass: ""
    size: 1Gi
    accessModes: [ReadWriteMany]
```

## Rollout, backup, restore, and rollback

1. Before rolling out the B2b image, quiesce Web writes, provision the durable source, and take a
   filesystem-consistent backup of the current host directory/PVC.
2. Restore the complete state into the durable source and apply the owner and mode contract. Do not
   start a new pod/container against an empty replacement.
3. Render the deployment and verify exactly one Web-only, read-write mount at the canonical target.
   Validate the mount on every Web workload instance. In Kubernetes, also verify PVC binding,
   access mode, storage-class semantics, and init success.
4. Start one Web replica first. Confirm that the previously active generation remains current and
   that staging/testing a draft persists across a pod/container replacement.
5. Scale to the intended replica count only after shared-volume coherence is verified.

Drain every legacy writer before considering any future cleanup of transaction temporary files.
There is no automatic orphan-temp deletion in this rollout. Backups and rollbacks must retain the
current pointer, every generation it may reference, legacy state, credential slots, and temporary
files until a separate validated recovery procedure classifies them.

For rollback, stop all Web writers before switching storage. An old image cannot safely write
while a generation committed by the new image remains authoritative. Restore or reattach the last
complete pre-rollout backup, then roll back the workload version while keeping the durable mount
attached.
Only project state into an older format through an explicit, validated manual procedure performed
with all writers stopped; never infer compatibility or repoint the old image at a newly empty claim.
Keep the failed volume isolated for forensics and do not delete or sweep it during rollback.
