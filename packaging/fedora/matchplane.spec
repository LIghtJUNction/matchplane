%global debug_package %{nil}

Name:           matchplane
Version:        %{matchplane_version}
Release:        1%{?dist}
Summary:        Federated AI matching infrastructure
License:        LicenseRef-MatchPlane-Pending
URL:            https://github.com/LIghtJUNction/matchplane
Source0:        %{name}-%{version}.tar.gz
Source1:        matchplane.conf

BuildRequires:  cargo
BuildRequires:  cmake
BuildRequires:  gcc-c++
BuildRequires:  libcurl-devel
BuildRequires:  nodejs
BuildRequires:  npm
BuildRequires:  protobuf-compiler
BuildRequires:  protobuf-devel
BuildRequires:  rust
BuildRequires:  systemd-rpm-macros
Requires:       ca-certificates
Requires:       systemd

%description
MatchPlane combines deterministic matching, PostgreSQL authority, Kafka facts,
Valkey projections, and a federated gRPC control plane.

%prep
%autosetup

%build
npm ci --ignore-scripts --prefix web
npm run build --prefix web
cargo build --release --locked --workspace --bins

%check
npm test --prefix web
cargo test --release --locked --workspace

%install
packaging/scripts/stage.sh %{buildroot} target/release

%pre
%sysusers_create_package %{name} %{SOURCE1}

%post
%systemd_post matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service

%preun
%systemd_preun matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service

%postun
%systemd_postun_with_restart matchplane-gateway.service matchplane-payment-service.service matchplane-event-relay.service matchplane-matcher.service matchplane-projector.service matchplane-vector-worker.service matchplane-federation-hub.service

%files
%config(noreplace) %attr(0640,root,matchplane) /etc/matchplane/matchplane.env
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

%changelog
* Fri Aug 14 2026 LIghtJUNction <lightjunction.me@gmail.com> - %{version}-1
- Initial MatchPlane package
