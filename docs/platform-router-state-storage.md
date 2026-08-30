# Persistent platform-router state

The Web control plane owns `/etc/matchplane/secrets/root-email`. This directory contains the
current-generation pointer, immutable generation JSON, audit-delivery state, and referenced
provider credential slots. It is secret-bearing durable state, not cache data: a restart must not
replace it with an empty directory, and it must never be mounted by gateway, payment, workers, or
builder workloads.

## Filesystem contract

The mount root is `root:matchplane-web` with mode `0770` on packaged hosts. In Compose, the numeric
Web identity owns the bind root. Web creates `generations/` at `0750` and creates generation,
pointer, audit, and credential files at `0640`. Bootstrap processes repair only the mount-root
owner and mode; they do not pre-create, truncate, copy, or sweep state files.
Credential-shaped temporary files are not age-cleaned by tmpfiles or a systemd timer. Transaction
recovery and bounded garbage collection remain application-owned.

## Docker Compose

The `web` service has one read-write bind mount at the exact target
`/etc/matchplane/secrets/root-email`. Its default source is the stable repository data directory
`var/platform-router-state`; override it with an absolute
`MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT` when state lives on an operator-managed disk.
Compose Web must not be scaled beyond one process.

Before the first start, and after changing the source path, prepare the directory for the `node`
identity in the pinned Web image:

```sh
sudo deploy/scripts/prepare-compose-router-state.sh
# Override only when the image/runtime uses different numeric IDs:
sudo MATCHPLANE_COMPOSE_WEB_UID=1000 MATCHPLANE_COMPOSE_WEB_GID=1000 \
  MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT=/srv/matchplane/platform-router-state \
  deploy/scripts/prepare-compose-router-state.sh
```

The helper refuses filesystem roots, multiple-leading-slash paths, and every symlink in an existing
path. Every existing parent ancestor must be owned by root or the explicitly trusted operator and
must not be group- or world-writable. `sudo` identifies its invoking UID as that trusted operator;
a direct root invocation may instead set `MATCHPLANE_COMPOSE_OPERATOR_UID` to the UID that owns the
checkout or external parent. The repository default remains viable in a normal operator-owned
mode-`0755` checkout and may create its `var/platform-router-state` path below the physical
repository root.

An external override must be absolute, its parent must already exist, and that parent ancestry must
remain operator-owned/trusted, non-symlink, and non-group/world-writable. The operator who owns this
ancestry remains trusted not to replace any entry between preparation and Compose lookup. Start
Compose immediately after preparation to minimize that unavoidable bind-path interval. The helper
creates only the final directory, changes its metadata through a no-follow descriptor, and preserves
every existing child byte-for-byte.

Back up the directory as one filesystem-consistent unit. To restore, stop Web, restore the complete
directory (including the current pointer and all referenced generations/credentials), run the
preparation script, run the manual `matchplane validate-mounts --json` gate, and only then start
Web. Never restore only the pointer or only a credential file. Empty state is valid only for a
verified first install, never as an automatic rollout replacement.

## Helm/Kubernetes

`web.platformRouterStorage` is mandatory. With no `existingClaim`, the chart creates a retained PVC
from an explicit production `storageClass`, a required `size`, and `accessModes`; blank
storage-class selection is allowed only for non-production renders. With `existingClaim`, it
mounts the pre-provisioned PVC and creates no claim. Values on an existing claim cannot prove its
live access mode, filesystem behavior, or reclaim policy; verify the actual PVC, PV, and CSI driver.

The chart-owned PVC has `helm.sh/resource-policy: keep`. Helm uninstall therefore leaves it behind,
and an operator must explicitly delete it after retention and recovery requirements are satisfied.
For production, select a storage class/PV whose reclaim policy is `Retain`; the chart annotation
does not override the storage backend's reclaim policy.

The PVC root is mounted only into a startup init container at a private staging path. The init runs
as the same non-root UID/GID as Web, with a read-only root filesystem, no privilege escalation, and
all capabilities dropped. It creates a `root-email/` child at exact mode `0770` when absent; an
existing symlink, non-directory, or wrong mode fails closed. It then verifies read/write/search
access and performs an exclusive file create, file `fsync`, atomic rename, directory `fsync`, and
unlink. This is runtime evidence for the selected CSI/filesystem, not an inference from declared
`accessModes`. No state or credential bytes are read.

Web mounts only that `root-email/` child by `subPath` at
`/etc/matchplane/secrets/root-email`, read-write, while retaining its read-only root filesystem. An
existing claim or restored volume must therefore provide this layout:

```text
PVC root/
└── root-email/    # directory, mode 0770, writable/searchable by Web UID/GID through fsGroup
```

Operators must pre-provision ownership/group access compatible with the chart's non-root
`podSecurityContext` and CSI `fsGroup` behavior. There is no privileged ownership-repair escape
hatch. If the driver cannot apply group access or support create/fsync/rename/directory-fsync, the
init fails and Web does not start.

## Single-writer rollout, backup, restore, and rollback

The router lock uses boot identity, PID, and process start ticks; those values do not establish
mutual exclusion across Pods or PID namespaces. M0 therefore enforces exactly one Web replica even
on RWX storage, and the Web Deployment uses `Recreate`. Rolling and canary Web updates are not
supported.

1. Before rollout, quiesce AI/router administration writes and stop the old Web workload. Wait
   until every old Web Pod, container, and process is dead; do not start the new image alongside a
   legacy writer.
2. Take a filesystem-consistent backup. Provision or restore the complete `root-email/` layout,
   including the current pointer, referenced generations and credentials, audit state, legacy
   state, and temporary files. Do not start against an empty replacement except on a verified first
   install.
3. Run `matchplane validate-mounts --json` manually before traffic. Render the deployment and
   verify the single Web-only read-write `subPath: root-email` mount, PVC binding, retention policy,
   storage-class semantics, and successful non-root startup init.
4. Start the one Web replica. Before admitting traffic, confirm that the previously active
   generation remains current and that staging/testing a draft persists across a stopped-then-
   started pod replacement.

Drain every legacy writer before considering any future cleanup of transaction temporary files.
There is no automatic orphan-temp deletion in this rollout. Backups and rollbacks must retain all
state until a separate validated recovery procedure classifies it.

For rollback, quiesce writes and wait for every new Web process to die before switching storage or
starting the old image. An old image cannot safely write while a generation committed by the new
image remains authoritative. Restore or reattach the last complete pre-rollout backup, keep the
retained failed volume isolated for forensics, run manual mount validation, and only then start the
single old Web process. Never infer format compatibility, repoint an old image at a newly empty
claim, or delete/sweep state as part of rollback.
