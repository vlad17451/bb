#!/usr/bin/env bash
set -euo pipefail

nameserver_rules=""
while read -r keyword address _; do
  [ "$keyword" = nameserver ] || continue
  family=ip
  case "$address" in *:*) family=ip6 ;; esac
  nameserver_rules+="    $family daddr $address meta l4proto { tcp, udp } th dport 53 accept"$'\n'
done </etc/resolv.conf

nft -f - <<EOF
table inet bb_fork_dev_egress {
  chain output {
    type filter hook output priority filter; policy accept;
    oif "lo" accept
    ct state established,related accept
${nameserver_rules}    ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } reject
    ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } reject
  }
}
EOF

command_status=0
setpriv --bounding-set=-net_admin --inh-caps=-net_admin --ambient-caps=-net_admin -- "$@" || command_status=$?

for _ in $(seq 300); do
  pgrep -x git >/dev/null || break
  sleep 0.1
done

exit "$command_status"
