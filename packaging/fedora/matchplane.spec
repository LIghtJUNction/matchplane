%global debug_package %{nil}

Name:           matchplane
Version:        %{matchplane_version}
Release:        1%{?dist}
Summary:        Federated AI matching infrastructure
License:        MIT
URL:            https://github.com/LIghtJUNction/matchplane
Source0:        %{name}-%{version}.tar.gz
Source1:        matchplane.conf

BuildRequires:  cargo
BuildRequires:  cmake
BuildRequires:  gcc-c++
BuildRequires:  libcurl-devel
BuildRequires:  curl
BuildRequires:  nodejs
BuildRequires:  unzip
BuildRequires:  protobuf-compiler
BuildRequires:  protobuf-devel
BuildRequires:  rust
BuildRequires:  systemd-rpm-macros
Requires:       bash
Requires:       ca-certificates
Requires:       bubblewrap
Requires:       coreutils
Requires:       git
Requires:       nodejs >= 22.12.0
Requires:       postgresql
Requires:       systemd
Requires:       util-linux

%description
MatchPlane combines deterministic matching, PostgreSQL authority, Kafka facts,
Valkey projections, and a federated gRPC control plane.

%prep
%autosetup

%build
bun install --frozen-lockfile --cwd web
# Bun's JavaScriptCore runtime has crashed intermittently in Fedora's containerized
# builders while collecting Next.js page data. Keep Bun for the locked install, but
# use Fedora's supported Node.js runtime for the deterministic build step.
(cd web && node node_modules/next/dist/bin/next build)
# Fedora's containerized builders can expose a large CPU count with a much
# smaller memory limit. Serialize the workspace build so concurrent linker
# processes do not exhaust the package-builder's memory.
CARGO_BUILD_JOBS=1 cargo build --release --locked --workspace --bins

%check
(cd web && node node_modules/vitest/vitest.mjs run)
CARGO_BUILD_JOBS=1 cargo test --release --locked --workspace

%install
packaging/scripts/stage.sh %{buildroot} target/release

%pre
%sysusers_create_package %{name} %{SOURCE1}

%post
%systemd_post matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-subplatform-builder.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service
/usr/bin/systemd-tmpfiles --create %{_tmpfilesdir}/matchplane.conf
%{_sbindir}/matchplane-postgres-backup-prepare --if-postgres-present
echo 'Configure /etc/matchplane/matchplane.env and /etc/matchplane/services/*.env before enabling services.'
echo 'The PostgreSQL backup timer is installed disabled; production operators must enable it explicitly.'

%preun
%systemd_preun matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-conversion-projector.service matchplane-matcher.service matchplane-projector.service matchplane-subplatform-builder.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service matchplane-postgres-backup.timer

%postun
%systemd_postun_with_restart matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-conversion-projector.service matchplane-matcher.service matchplane-projector.service matchplane-subplatform-builder.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service

%files
%config(noreplace) %attr(0640,root,matchplane) /etc/matchplane/matchplane.env
%config(noreplace) %attr(0644,root,root) /etc/matchplane/postgres-backup.conf
%dir %attr(0750,root,matchplane) /etc/matchplane/services
%{_bindir}/matchplane-conversion-projector
%{_bindir}/matchplane-event-relay
%{_bindir}/matchplane-federation-hub
%{_bindir}/matchplane-gateway
%{_bindir}/matchplane-matcher
%{_bindir}/matchplane-payment-service
%{_bindir}/matchplane-projector
%{_bindir}/matchplane-subplatform-builder
%{_bindir}/matchplane-vector-worker
%{_bindir}/matchplane-postgres-backup-verify
%{_bindir}/matchplane
%{_sbindir}/matchplane-postgres-backup-prepare
%{_libexecdir}/matchplane-postgres-backup
%{_unitdir}/matchplane-*.service
%{_unitdir}/matchplane-*.timer
%{_sysusersdir}/matchplane.conf
%{_tmpfilesdir}/matchplane.conf
%{_datadir}/matchplane/web
%{_docdir}/matchplane/README.md
%{_docdir}/matchplane/ARCHITECTURE.md
%{_docdir}/matchplane/marketplace-payments.md
%{_docdir}/matchplane/cli-and-mcp.md
%{_docdir}/matchplane/postgresql-backup-gate.md
%{_docdir}/matchplane/web-THIRD_PARTY_NOTICES.md
%{_docdir}/matchplane/*.json
%{_datadir}/matchplane/skills
%license %{_datadir}/licenses/matchplane/LICENSE
%license %{_datadir}/licenses/matchplane/liquid-gooey.LICENSE
%license %{_datadir}/licenses/matchplane/metal-fx.LICENSE

%changelog
* Fri Aug 14 2026 LIghtJUNction <lightjunction.me@gmail.com> - %{version}-1
- Initial MatchPlane package
