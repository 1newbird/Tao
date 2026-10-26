// Test-process preload only. Production Runtime has no network fixture switch.
import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
const origin = new URL(process.env.TAO_TEST_GITHUB_ORIGIN);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Invalid isolated fixture address");
const hosts = ["api.github.com", "raw.githubusercontent.com"];
const originalRequest = https.request;
const originalLookup = dns.lookup;
dns.lookup = async (host, options) => hosts.includes(host) ? options?.all ? [{ address: "93.184.216.34", family: 4 }] : { address: "93.184.216.34", family: 4 } : originalLookup(host, options);
https.request = (url, options, callback) => {
  const target = url instanceof URL ? url : typeof url === "string" ? new URL(url) : null;
  if (!target || !hosts.includes(target.hostname)) return originalRequest(url, options, callback);
  return http.request(new URL(`/github/${target.hostname}${target.pathname}${target.search}`, origin), { ...options, lookup: undefined }, callback);
};
syncBuiltinESMExports();
