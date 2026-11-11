// The rule about the Host header, as pure functions, for the whole app (UI, /api, /mcp).
// Why it exists: DNS rebinding. A web page on evil.example can point its own name at
// 127.0.0.1 and then read this tool from the analyst's browser. For the browser that is
// a same-origin request, so it sends no Origin header and no CORS rule applies. The one
// thing the attacker cannot fake is the Host header: it still says evil.example.
// The Host header is untrusted request text. It is only matched and compared here.

// The names a browser on this machine uses for this machine.
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

// Reads ALLOWED_HOSTS: extra hostnames separated by commas, without ports, for someone
// who serves the tool under another name, such as "findings.internal.example".
export function parseAllowedHosts(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter((hostname) => hostname !== "");
}

// A Host header is "name", "name:port" or "[ipv6]:port". Anything else (a space, a
// slash, an @, two ports) does not match and is refused. A fixed pattern over three
// separate character sets, so it reads the text once however long it is.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/;

// The hostname in lower case and without the port, or undefined when the header is not
// a host at all. Hostnames are case-insensitive, and "localhost." with a final dot is
// the same name written out in full, so both are folded before comparing.
function hostnameOf(host: string): string | undefined {
  const match = HOST_HEADER.exec(host.toLowerCase());
  if (match === null) return undefined;
  return (match[1] ?? "").replace(/\.$/, "");
}

// The whole hostname is compared, never a prefix, so "localhost.evil.example" is not
// local. A missing header is refused too: every browser and HTTP/1.1 client sends one.
export function isAllowedHost(host: string | undefined, allowed: string[]): boolean {
  if (host === undefined) return false;
  const hostname = hostnameOf(host);
  if (hostname === undefined) return false;
  return LOCAL_HOSTNAMES.includes(hostname) || allowed.includes(hostname);
}
