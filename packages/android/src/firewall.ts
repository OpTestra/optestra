// The device-side half of the network guard (SAF-1, MOB-7). The emulator hands
// every TCP connection of the device to the host-side guard (`-http-proxy`),
// including those to its host alias 10.0.2.2, but it passes non-TCP traffic (UDP,
// ICMP) straight to the host's network. These iptables rules, applied as root
// inside the device where the app (never root) can't change them, let through
// only loopback, replies to connections made *to* the device (adb), DNS to the
// emulator's resolver, and TCP from the app under test (which goes to the
// guard). Everything else is rejected: UDP (QUIC), and TCP from any other process,
// so the guard sees only the app's own connections and nothing else on the device
// (connectivity probes, other apps) goes out. Emulator kernels have no LOG
// target, so refusals are counted (the REJECT rules' packet counters), not
// itemised; the app's own are counted apart from the system's.

export const EMULATOR_DNS = "10.0.2.3";
const CHAIN = "uih_out";

type Rule = readonly string[];

const ipt = (...tokens: string[]): Rule => ["iptables", ...tokens];
const ip6t = (...tokens: string[]): Rule => ["ip6tables", ...tokens];

/** Rules that remove the harness's chains (idempotent; errors are ignored by the shell). */
export function resetRules(): Rule[] {
  return [
    ipt("-D", "OUTPUT", "-j", CHAIN),
    ipt("-F", CHAIN),
    ipt("-X", CHAIN),
    ip6t("-D", "OUTPUT", "-j", CHAIN),
    ip6t("-F", CHAIN),
    ip6t("-X", CHAIN),
  ];
}

/** The rule set for a session, applied after `resetRules()`. */
export function firewallRules(appUid: number): Rule[] {
  if (!Number.isInteger(appUid) || appUid <= 0) throw new Error("the firewall needs the app's uid");
  const uid = String(appUid);
  const family = (f: typeof ipt, dns: boolean): Rule[] => [
    f("-N", CHAIN),
    f("-A", CHAIN, "-o", "lo", "-j", "RETURN"),
    f("-A", CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"),
    ...(dns
      ? [f("-A", CHAIN, "-p", "udp", "-d", EMULATOR_DNS, "--dport", "53", "-j", "RETURN")]
      : []),
    // The app's TCP: the emulator hands it to the guard, which enforces the allowlist.
    f("-A", CHAIN, "-p", "tcp", "-m", "owner", "--uid-owner", uid, "-j", "RETURN"),
    // The app's other traffic (counted as the app's refusals), then everyone else's.
    f("-A", CHAIN, "-m", "owner", "--uid-owner", uid, "-j", "REJECT"),
    f("-A", CHAIN, "-j", "REJECT"),
    f("-I", "OUTPUT", "1", "-j", CHAIN),
  ];
  return [...family(ipt, true), ...family(ip6t, false)];
}

/** Packets the REJECT rules dropped so far. */
export interface FirewallCounters {
  /** Non-TCP traffic (UDP, ICMP) from the app under test, IPv4 and IPv6. */
  app: number;
  /** Anything from the rest of the system (not the app's). */
  system: number;
}

export const COUNTERS_COMMAND: readonly (readonly string[])[] = [
  ["iptables", "-S", CHAIN, "-v"],
  ["ip6tables", "-S", CHAIN, "-v"],
];

/** Reads the REJECT counters from `iptables -S uih_out -v` output (both families). */
export function parseCounters(output: string): FirewallCounters {
  const counters: FirewallCounters = { app: 0, system: 0 };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(`-A ${CHAIN} `) || !line.includes("-j REJECT")) continue;
    const packets = Number(/ -c (\d+) \d+/.exec(line)?.[1] ?? 0);
    if (line.includes("--uid-owner")) counters.app += packets;
    else counters.system += packets;
  }
  return counters;
}
