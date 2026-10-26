//! IPC goes only to the exact origin the window is served from. The port is chosen at launch
//! (`ZK_PORT`), so the static capability holds the permissions and grants them to nothing; the
//! shell adds a copy scoped to the real origin once it knows it.
//!
//! Tauri sorts a request's origin into one of two kinds, and a capability only reaches the kinds it
//! names: the origin of the configured app URL (`devUrl` under `tauri dev`, else `frontendDist`)
//! counts as "local", every other origin as "remote" and is matched against `remote.urls`.

use tauri::utils::config::FrontendDist;

/// The static capability whose permissions are granted at runtime.
pub const TEMPLATE: &str = include_str!("../capabilities/default.json");

/// The origin Tauri counts as local, given whether this is a `tauri dev` run.
pub fn configured_app_origin(config: &tauri::Config, dev: bool) -> Option<String> {
    let url = if dev {
        config.build.dev_url.as_ref()
    } else {
        match config.build.frontend_dist.as_ref() {
            Some(FrontendDist::Url(url)) => Some(url),
            _ => None,
        }
    };
    url.and_then(crate::navigation::web_origin)
}

/// `template` re-issued under its own identifier, for `origin` (`scheme://host:port`) only: as the
/// local grant when `origin` is the configured app origin, otherwise as an exact remote pattern.
pub fn for_origin(template: &str, origin: &str, configured_app_origin: Option<&str>) -> String {
    let mut capability: serde_json::Value =
        serde_json::from_str(template).expect("the capability file is valid JSON");
    let fields = capability
        .as_object_mut()
        .expect("the capability file is a JSON object");
    fields.remove("$schema");
    let identifier = fields["identifier"]
        .as_str()
        .unwrap_or("default")
        .to_string();
    fields.insert(
        "identifier".into(),
        format!("{identifier}-app-origin").into(),
    );
    let is_local = configured_app_origin == Some(origin);
    fields.insert("local".into(), is_local.into());
    if is_local {
        fields.remove("remote");
    } else {
        fields.insert("remote".into(), serde_json::json!({ "urls": [origin] }));
    }
    capability.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::Origin;
    use tauri::utils::acl::capability::{Capability, CapabilityFile};
    use tauri::Url;

    const RELEASE_ORIGIN: &str = "http://127.0.0.1:8790";
    const DEV_ORIGIN: &str = "http://localhost:5173";

    fn parse(json: &str) -> Capability {
        match json
            .parse::<CapabilityFile>()
            .expect("Tauri accepts the capability")
        {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("expected a single capability"),
        }
    }

    fn context() -> tauri::Context<tauri::Wry> {
        tauri::generate_context!(test = true)
    }

    fn remote(url: &str) -> Origin {
        Origin::Remote {
            url: Url::parse(url).unwrap(),
        }
    }

    /// Whether the app's IPC answers a request from `origin` once the shell has granted the
    /// commands to `served` — resolved by Tauri's own authority, as a real request would be.
    fn reaches(served: &str, configured: Option<&str>, origin: &Origin) -> bool {
        let mut context = context();
        let authority = context.runtime_authority_mut();
        authority
            .add_capability(for_origin(TEMPLATE, served, configured))
            .expect("the capability resolves against the app's permissions");
        authority
            .resolve_access("open_devtools", "main", "main", origin)
            .is_some()
    }

    #[test]
    fn the_static_capability_grants_nothing_by_itself() {
        let capability = parse(TEMPLATE);
        assert!(!capability.local);
        assert!(capability.remote.is_none());
        let mut context = context();
        let authority = context.runtime_authority_mut();
        for origin in [Origin::Local, remote(RELEASE_ORIGIN), remote(DEV_ORIGIN)] {
            assert!(
                authority
                    .resolve_access("open_devtools", "main", "main", &origin)
                    .is_none(),
                "{origin}"
            );
        }
    }

    #[test]
    fn the_configured_app_origin_is_the_one_tauri_counts_as_local() {
        let context = context();
        assert_eq!(
            configured_app_origin(context.config(), false).as_deref(),
            Some(RELEASE_ORIGIN)
        );
        assert_eq!(
            configured_app_origin(context.config(), true).as_deref(),
            Some(DEV_ORIGIN)
        );
    }

    #[test]
    fn serving_from_the_configured_app_origin_grants_the_local_origin() {
        for (served, dev) in [(RELEASE_ORIGIN, false), (DEV_ORIGIN, true)] {
            let configured = configured_app_origin(context().config(), dev);
            assert!(
                reaches(served, configured.as_deref(), &Origin::Local),
                "{served}"
            );
            assert!(
                !reaches(
                    served,
                    configured.as_deref(),
                    &remote("http://127.0.0.1:9124")
                ),
                "{served}"
            );
        }
    }

    #[test]
    fn serving_from_another_port_grants_exactly_that_origin() {
        let configured = Some(RELEASE_ORIGIN);
        let served = "http://127.0.0.1:9123";
        assert!(reaches(served, configured, &remote(served)));
        assert!(reaches(
            served,
            configured,
            &remote("http://127.0.0.1:9123/?token=abc")
        ));
        assert!(!reaches(served, configured, &Origin::Local));
        for other in [
            "http://127.0.0.1:8790",
            "http://127.0.0.1:9124",
            "http://localhost:9123",
            "https://127.0.0.1:9123",
            "http://evil.example/http://127.0.0.1:9123",
        ] {
            assert!(!reaches(served, configured, &remote(other)), "{other}");
        }
    }

    #[test]
    fn the_runtime_capability_keeps_the_static_permissions_and_windows() {
        let template = parse(TEMPLATE);
        for configured in [None, Some(DEV_ORIGIN)] {
            let runtime = parse(&for_origin(TEMPLATE, DEV_ORIGIN, configured));
            assert_eq!(runtime.permissions, template.permissions);
            assert_eq!(runtime.windows, template.windows);
            assert_ne!(runtime.identifier, template.identifier);
        }
    }
}
