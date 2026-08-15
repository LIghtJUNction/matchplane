fn main() {
    // `sqlx::migrate!` embeds the directory at compile time, but Cargo does not
    // otherwise notice a newly added migration file. Keep release binaries in
    // sync with the checked-in migration set.
    println!("cargo:rerun-if-changed=../../migrations");
}
