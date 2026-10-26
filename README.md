# luci-app-mdns3 — Multi-DNS (mDNS3) Manager for OpenWrt LuCI

`luci-app-mdns3` is a client-side OpenWrt LuCI application that manages per-VLAN and per-IP-range DNS server assignments (`dnsmasq` tags and `dhcp-range` rules) along with automated firewall enforcement to prevent DNS, DNS-over-TLS (DoT), DNS-over-QUIC (DoQ), DNS-over-HTTPS (DoH), and IPv6 DNS leaks.

---

## Features

- **Service Toggle (`ON` / `OFF`)**
  - Reads and writes the active state in `/etc/config/dhcp.mode` (`on` or `off`).
  - Automatically stages, commits, or removes all `mDNS3`-managed firewall rules when toggled.
  - **Non-destructive design**: Never modifies, moves, or overwrites `/etc/config/dhcp` (it only reads `/etc/config/dhcp` to discover available DHCP VLAN interfaces).

- **DNS Server Tags (`mdns3_servers.conf`)**
  - Define named DNS profiles (`tag`) mapped to a specific IPv4 DNS server (`dhcp-option=tag:<name>,6,<dns_ip>`).
  - Automatically includes a default `normal` tag using the router's LAN IP (`network.lan.ipaddr` with CIDR stripped) and an `adblock` tag (`94.140.14.14`).
  - Live synchronization: adding, renaming, or deleting a tag immediately updates the **Assigned DNS** dropdowns in the Rules table without reloading the page.

- **VLAN & IP Range Assignment Rules (`mdns3_rules.conf`)**
  - Assign a DHCP VLAN interface, `Start IP`, `End IP`, lease duration, and DNS tag (`dhcp-range=set:<tag>,<start_ip>,<end_ip>,255.255.255.0,<lease>`).
  - Strict validation:
    - Rejects malformed IPv4 addresses or octets outside `0–255`.
    - Ensures `Start IP <= End IP`.
    - Detects and blocks overlapping IP ranges within the same VLAN.

- **Automatic CIDR Range Decomposition**
  - OpenWrt's firewall (`fw3`/`fw4`) and LuCI firewall UI do not accept `start_ip-end_ip` range notation in `option src_ip`.
  - `luci-app-mdns3` automatically decomposes any arbitrary `[Start IP, End IP]` range into the minimal exact set of CIDR blocks (e.g., `192.168.51.2`–`192.168.51.10` → `192.168.51.2/31`, `192.168.51.4/30`, `192.168.51.8/31`, `192.168.51.10/32`).

- **Comprehensive DNS Leak Protection**
  When `mDNS3` is `ON`, the following firewall and `dnsmasq` protections are enforced for every configured rule:
  1. **DoH Canary Domains (`mdns3_servers.conf`)**:
     - `server=/use-application-dns.net/` (`NXDOMAIN` for Firefox DoH canary)
     - `address=/_dns.resolver.arpa/0.0.0.0` and `address=/_dns.resolver.arpa/::` (blocks DDR auto-upgrade to DoH/DoT)
  2. **`Allow-DNS-mDNS3`**: Allows UDP/TCP port `53` from the rule's CIDR blocks to the assigned DNS server IP.
  3. **`Block-DNS-mDNS3`**: Rejects UDP/TCP port `53` from the rule's CIDR blocks to any other IPv4 address.
  4. **`Block-DoT-mDNS3`**: Rejects TCP/UDP port `853` (blocks DNS-over-TLS and DNS-over-QUIC).
  5. **`Block-DoH-mDNS3`**: Rejects TCP/UDP port `443` to known public DoH resolver IPs (Cloudflare, Google, Quad9, OpenDNS, AdGuard, CleanBrowsing, NextDNS).
  6. **`Block-DNS6-mDNS3`**: Rejects IPv6 UDP/TCP ports `53` and `853` from the rule's source VLAN to prevent IPv6 DNS bypasses.

- **Separate `Save` and `Save & Apply` Actions**
  - **Save**: Validates inputs, writes `/etc/mdns3.d/mdns3_servers.conf` and `/etc/mdns3.d/mdns3_rules.conf`, and stages the firewall rules in UCI without restarting services.
  - **Save & Apply**: Performs all **Save** actions, commits `/etc/config/firewall`, and restarts `dnsmasq` and `firewall`.

---

## Package Structure

```text
luci-app-mdns3/
├── Makefile                                         # OpenWrt package definition (PKGARCH:=all)
├── README.md                                        # Package documentation
├── htdocs/
│   └── luci-static/resources/view/mdns3.js          # LuCI client-side view & logic
└── root/
    ├── etc/uci-defaults/99_luci-app-mdns3           # First-boot / post-install initialization script
    └── usr/share/
        ├── luci/menu.d/luci-app-mdns3.json          # Registers Network -> Multi-DNS (mDNS3) menu entry
        └── rpcd/acl.d/luci-app-mdns3.json           # RPCD ACL permissions for file, UCI, and init actions
```

---

## Generated Configuration Files on the Router

| File Path | Purpose |
| :--- | :--- |
| `/etc/config/dhcp.mode` | Stores the service status (`on` or `off`). |
| `/etc/mdns3.d/mdns3_servers.conf` | `dnsmasq` DoH canary domains and `dhcp-option=tag:<tag>,6,<ip>` declarations. |
| `/etc/mdns3.d/mdns3_rules.conf` | `dnsmasq` `dhcp-range=set:<tag>,<start_ip>,<end_ip>,255.255.255.0,<lease>` rules. |
| `/etc/config/firewall` | UCI firewall rules containing `mDNS3` in their rule name. |

---

## Building the Package

From the OpenWrt buildroot directory (`~/openwrt`):

```bash
# Clean and compile luci-app-mdns3
make package/luci-app-mdns3/{clean,compile} V=s
```

Because `PKGARCH:=all` is set in the `Makefile`, the resulting `.apk` or `.ipk` package is architecture-independent and runs on any OpenWrt target containing `luci-base`.

---

## Installation

### OpenWrt 24.10+ (`apk`)

```bash
apk add --allow-untrusted /tmp/luci-app-mdns3-1.2-r1.apk
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

### OpenWrt 23.05 and earlier (`opkg` / `.ipk`)

```bash
opkg install --force-reinstall /tmp/luci-app-mdns3_1.2-r1_all.ipk
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

Once installed, open LuCI in your browser and navigate to **Network → Multi-DNS (mDNS3)** (`/cgi-bin/luci/admin/network/mdns3`).
