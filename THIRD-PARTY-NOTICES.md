**English** | [日本語](./THIRD-PARTY-NOTICES.ja.md)

# Third-Party License Notices

zashiki depends on numerous open-source software packages. This file describes a summary
of the license composition of its dependencies, along with obligations that require special
attention (such as weak copyleft). The full license text of each dependency can be generated
using the "Generating the Full List" procedure below.

## Audit Results (as of 2026-08-06)

- **npm dependencies**: approximately 220 packages. **All permissive** (MIT / Apache-2.0 / ISC / BSD-2/3-Clause / CC0-1.0 / MIT-0 / Unicode, etc.). Strong copyleft (GPL / AGPL) is **absent**.
- **Rust dependencies**: approximately 468 crates. Most are permissive, such as `MIT OR Apache-2.0`. Strong copyleft (GPL / AGPL) is **absent**.

There are no licensing obstacles to publishing source or distributing binaries for this project (MIT).

### Dependencies Requiring Attention (weak copyleft: MPL-2.0)

The following crates are MPL-2.0 (**file-level** weak copyleft). **As long as you do not modify the relevant files**,
there is no problem using them or distributing binaries in this project (if you do modify them, you incur an
obligation to disclose the source of the modified MPL files. There is no obligation to relicense the entire
project under MPL).

- `cssparser` / `cssparser-macros` / `selectors` / `dtoa-short` (from Servo; via Tauri's WebView / style resolution)
- `option-ext` (via `dirs`)

### Dependencies Where MIT Is Selected Under Dual Licensing

- `r-efi` (`MIT OR Apache-2.0 OR LGPL-2.1-or-later` → **MIT selected**. No LGPL obligation arises.)

## Generating the Full List

At release time, you can generate a complete notice including the full license text of each dependency with the following.

```sh
# Rust (either one)
cargo install cargo-about && cargo about generate > third-party-rust.txt
# or cargo install cargo-bundle-licenses && cargo bundle-licenses --format toml

# npm
pnpm licenses list            # summary
pnpm licenses list --json     # machine-readable (per package)
```

> Note: Dependencies change with updates, so this summary reflects the time of the audit. Re-audit when publishing or releasing.
