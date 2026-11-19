//! Which destinations zashiki may fetch on its own to describe a session link: public web hosts only,
//! never anything on this machine or a private network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::{Host, Url};

/// A plain `http` / `https` URL on its default port, without credentials, naming a host that is not
/// local. A host name still has to resolve to public addresses only (`public_addrs`).
pub(crate) fn is_fetchable_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && match url.host() {
            Some(Host::Domain(name)) => is_public_host_name(name),
            Some(Host::Ipv4(ip)) => is_public_ip(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => is_public_ip(IpAddr::V6(ip)),
            None => false,
        }
}

const LOCAL_SUFFIXES: [&str; 3] = [".localhost", ".local", ".internal"];

fn is_public_host_name(name: &str) -> bool {
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    name.contains('.')
        && name != "localhost"
        && !LOCAL_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// The resolved addresses of a fetchable URL's host, when every one of them is a public address on
/// a web port. One private address refuses the whole host rather than being skipped.
pub(crate) fn public_addrs(addrs: Vec<SocketAddr>) -> Option<Vec<SocketAddr>> {
    let all_public = addrs
        .iter()
        .all(|addr| matches!(addr.port(), 80 | 443) && is_public_ip(addr.ip()));
    (all_public && !addrs.is_empty()).then_some(addrs)
}

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

/// Each `(network, prefix length)` is special-use: this host, private, shared, documentation,
/// benchmarking, multicast or reserved.
const NON_PUBLIC_IPV4: [(Ipv4Addr, u32); 15] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 88, 99, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let bits = u32::from(ip);
    !NON_PUBLIC_IPV4.iter().any(|&(network, prefix)| {
        let mask = u32::MAX << (32 - prefix);
        bits & mask == u32::from(network)
    })
}

fn ipv6_in(ip: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX << (128 - prefix);
    u128::from(ip) & mask == u128::from(network)
}

const NAT64_PREFIX: Ipv6Addr = Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0);

/// Only global unicast (`2000::/3`) outside its special-use blocks is public. An IPv4 address carried
/// in IPv6 (mapped, or behind the well-known NAT64 prefix) is judged as that IPv4 address.
fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_ipv4(v4);
    }
    if ipv6_in(ip, NAT64_PREFIX, 96) {
        let [.., a, b, c, d] = ip.octets();
        return is_public_ipv4(Ipv4Addr::new(a, b, c, d));
    }
    let global_unicast = ipv6_in(ip, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3);
    let special = [
        (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
        (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
        (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
        (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
    ];
    global_unicast
        && !special
            .iter()
            .any(|&(network, prefix)| ipv6_in(ip, network, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetchable(url: &str) -> bool {
        is_fetchable_url(&Url::parse(url).unwrap())
    }

    fn public(ip: &str) -> bool {
        is_public_ip(ip.parse().unwrap())
    }

    #[test]
    fn public_web_urls_are_fetchable() {
        for url in [
            "https://example.com/",
            "http://example.com/a?b#c",
            "https://EXAMPLE.com:443/",
            "http://example.com:80/",
            "https://sub.example.co.jp/x",
            "https://93.184.216.34/",
            "https://[2606:2800:220:1:248:1893:25c8:1946]/",
        ] {
            assert!(fetchable(url), "{url}");
        }
    }

    #[test]
    fn other_schemes_and_ports_are_not_fetchable() {
        for url in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
            "https://example.com:8443/",
            "http://example.com:443/",
            "https://example.com:80/",
        ] {
            assert!(!fetchable(url), "{url}");
        }
    }

    #[test]
    fn urls_carrying_credentials_are_not_fetchable() {
        assert!(!fetchable("https://user@example.com/"));
        assert!(!fetchable("https://user:pass@example.com/"));
        assert!(!fetchable("https://:pass@example.com/"));
    }

    #[test]
    fn local_and_single_label_host_names_are_not_fetchable() {
        for url in [
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://printer.local/",
            "http://printer.local./",
            "http://db.internal/",
            "http://metadata.google.internal/",
            "http://intranet/",
            "http://intranet./",
        ] {
            assert!(!fetchable(url), "{url}");
        }
    }

    #[test]
    fn private_ip_literals_are_not_fetchable_however_they_are_written() {
        for url in [
            "http://127.0.0.1/",
            "http://0x7f.1/",
            "http://2130706433/",
            "http://0/",
            "http://10.1.2.3/",
            "http://169.254.169.254/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:a9fe:a9fe]/",
            "http://[fd00::1]/",
        ] {
            assert!(!fetchable(url), "{url}");
        }
    }

    #[test]
    fn public_ipv4_addresses_are_public() {
        for ip in [
            "93.184.216.34",
            "1.1.1.1",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.0",
            "172.32.0.1",
            "198.20.0.1",
        ] {
            assert!(public(ip), "{ip}");
        }
    }

    #[test]
    fn non_public_ipv4_addresses_are_refused() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn global_ipv6_addresses_are_public() {
        for ip in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::200e",
        ] {
            assert!(public(ip), "{ip}");
        }
    }

    #[test]
    fn non_public_ipv6_addresses_are_refused() {
        for ip in [
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "3fff::1",
            "2001::1",
            "2002:c000:0204::1",
            "100::1",
            "64:ff9b:1::1",
            "::7f00:1",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn an_ipv4_address_inside_ipv6_is_judged_as_the_ipv4_address() {
        assert!(!public("::ffff:127.0.0.1"));
        assert!(!public("::ffff:10.0.0.1"));
        assert!(!public("64:ff9b::a9fe:a9fe"));
        assert!(public("::ffff:93.184.216.34"));
        assert!(public("64:ff9b::5db8:d822"));
    }

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn resolved_addresses_pass_only_when_every_one_is_public_on_a_web_port() {
        let good = vec![addr("93.184.216.34:443"), addr("[2606:4700::1111]:443")];
        assert_eq!(public_addrs(good.clone()), Some(good));
        assert_eq!(
            public_addrs(vec![addr("93.184.216.34:80")]),
            Some(vec![addr("93.184.216.34:80")])
        );
        assert_eq!(
            public_addrs(vec![addr("93.184.216.34:443"), addr("127.0.0.1:443")]),
            None
        );
        assert_eq!(public_addrs(vec![addr("93.184.216.34:8080")]), None);
        assert_eq!(public_addrs(vec![]), None);
    }
}
