//! IPC goes only to the exact origin the window is served from. The port is chosen at launch
//! (`ZK_PORT`), so the static capability holds the permissions and grants them to nothing; the
//! shell adds a copy scoped to the real origin once it knows it.

/// The static capability whose permissions are granted at runtime.
pub const TEMPLATE: &str = include_str!("../capabilities/default.json");

/// `template` re-issued under its own identifier, for `origin` (`scheme://host:port`) only.
pub fn for_origin(template: &str, origin: &str) -> String {
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
    fields.insert("local".into(), false.into());
    fields.insert("remote".into(), serde_json::json!({ "urls": [origin] }));
    capability.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::acl::capability::{Capability, CapabilityFile};
    use tauri::utils::acl::RemoteUrlPattern;
    use tauri::Url;

    fn parse(json: &str) -> Capability {
        match json
            .parse::<CapabilityFile>()
            .expect("Tauri accepts the capability")
        {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("expected a single capability"),
        }
    }

    fn matches(capability: &Capability, origin: &str) -> bool {
        let url = Url::parse(origin).unwrap();
        capability
            .remote
            .as_ref()
            .map(|remote| {
                remote
                    .urls
                    .iter()
                    .any(|pattern| pattern.parse::<RemoteUrlPattern>().unwrap().test(&url))
            })
            .unwrap_or(false)
    }

    #[test]
    fn the_static_capability_grants_nothing_by_itself() {
        let capability = parse(TEMPLATE);
        assert!(
            !capability.local,
            "a local grant would cover the configured frontend URL"
        );
        assert!(
            capability.remote.is_none(),
            "remote origins are added at runtime"
        );
    }

    #[test]
    fn the_runtime_capability_reaches_only_the_served_origin() {
        let capability = parse(&for_origin(TEMPLATE, "http://127.0.0.1:9123"));
        assert!(!capability.local);
        assert!(matches(&capability, "http://127.0.0.1:9123"));
        assert!(matches(&capability, "http://127.0.0.1:9123/?token=abc"));
        for other in [
            "http://127.0.0.1:8790",
            "http://127.0.0.1:9124",
            "http://localhost:9123",
            "https://127.0.0.1:9123",
            "http://evil.example/http://127.0.0.1:9123",
        ] {
            assert!(!matches(&capability, other), "{other}");
        }
    }

    #[test]
    fn the_runtime_capability_keeps_the_static_permissions_and_windows() {
        let template = parse(TEMPLATE);
        let runtime = parse(&for_origin(TEMPLATE, "http://localhost:5173"));
        assert_eq!(runtime.permissions, template.permissions);
        assert_eq!(runtime.windows, template.windows);
        assert_ne!(runtime.identifier, template.identifier);
    }
}
