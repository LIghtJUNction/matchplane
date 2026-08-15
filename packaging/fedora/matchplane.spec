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
Requires:       ca-certificates
Requires:       nodejs >= 22.12.0
Requires:       systemd

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
%systemd_post matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service
echo 'Configure /etc/matchplane/matchplane.env and /etc/matchplane/services/*.env before enabling services.'

%preun
%systemd_preun matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service

%postun
%systemd_postun_with_restart matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service matchplane-web.service

%files
%config(noreplace) %attr(0640,root,matchplane) /etc/matchplane/matchplane.env
%dir %attr(0750,root,root) /etc/matchplane/services
%{_bindir}/matchplane-event-relay
%{_bindir}/matchplane-federation-hub
%{_bindir}/matchplane-gateway
%{_bindir}/matchplane-matcher
%{_bindir}/matchplane-payment-service
%{_bindir}/matchplane-projector
%{_bindir}/matchplane-vector-worker
%{_bindir}/xtask
%{_unitdir}/matchplane-*.service
%{_sysusersdir}/matchplane.conf
%{_tmpfilesdir}/matchplane.conf
%{_datadir}/matchplane/web
%{_docdir}/matchplane/README.md
%{_docdir}/matchplane/ARCHITECTURE.md
%{_docdir}/matchplane/marketplace-payments.md
%license %{_datadir}/licenses/matchplane/LICENSE

%changelog
* Fri Aug 14 2026 LIghtJUNction <lightjunction.me@gmail.com> - %{version}-1
- Initial MatchPlane package
