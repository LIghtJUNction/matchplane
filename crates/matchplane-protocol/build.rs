fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protos = [
        "../../proto/matchplane/v1/common.proto",
        "../../proto/matchplane/v1/matching.proto",
        "../../proto/matchplane/v1/federation.proto",
    ];
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .type_attribute(
            ".matchplane.v1.MatchingCommand.command",
            "#[allow(clippy::large_enum_variant)]",
        )
        .compile_protos(&protos, &["../../proto"])?;
    println!("cargo:rerun-if-changed=../../proto");
    Ok(())
}
