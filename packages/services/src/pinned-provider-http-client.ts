import { request as requestHttp } from "node:http";
import {
  request as requestHttps,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";

export interface PinnedProviderDestination {
  readonly hostname: string;
  readonly addresses: readonly string[];
}

export type PinnedProviderHttpClient = (
  url: URL,
  init: RequestInit,
  destination: PinnedProviderDestination,
) => Promise<Response>;

export interface PinnedProviderRequestOptions extends HttpsRequestOptions {
  readonly autoSelectFamily?: boolean;
}

function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function responseHasBody(method: string, status: number): boolean {
  return (
    method.toUpperCase() !== "HEAD" &&
    status !== 204 &&
    status !== 205 &&
    status !== 304
  );
}

function canonicalHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function createPinnedLookup(
  destination: PinnedProviderDestination,
): LookupFunction {
  const addresses = Array.from(new Set(destination.addresses)).map((address) => ({
    address,
    family: isIP(address),
  }));

  return (hostname, options, callback) => {
    if (canonicalHostname(hostname) !== destination.hostname) {
      const error = new Error(
        "Pinned provider lookup was requested for an unexpected hostname.",
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }

    const requestedFamily =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    const matchingAddresses =
      requestedFamily === 4 || requestedFamily === 6
        ? addresses.filter(({ family }) => family === requestedFamily)
        : addresses;
    if (matchingAddresses.length === 0) {
      const error = new Error(
        "No validated provider address matches the requested family.",
      ) as NodeJS.ErrnoException;
      error.code = "EAI_ADDRFAMILY";
      callback(error, "", 0);
      return;
    }

    if (options.all) {
      callback(null, matchingAddresses);
      return;
    }
    const firstAddress = matchingAddresses[0];
    if (firstAddress === undefined) return;
    callback(null, firstAddress.address, firstAddress.family);
  };
}

export function buildPinnedProviderRequestOptions(
  url: URL,
  init: RequestInit,
  destination: PinnedProviderDestination,
): PinnedProviderRequestOptions {
  const pinnedAddress = destination.addresses[0];
  if (
    pinnedAddress === undefined ||
    destination.addresses.some((address) => isIP(address) === 0) ||
    destination.hostname !== canonicalHostname(url.hostname)
  ) {
    throw new Error("Validated provider destination is unavailable.");
  }

  const headers = new Headers(init.headers);
  headers.set("Host", url.host);
  const destinationIsIp = isIP(destination.hostname) !== 0;
  return {
    protocol: url.protocol,
    hostname: destinationIsIp ? pinnedAddress : destination.hostname,
    port: url.port.length > 0 ? url.port : undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    signal: init.signal ?? undefined,
    ...(!destinationIsIp
      ? {
          lookup: createPinnedLookup(destination),
          autoSelectFamily: destination.addresses.length > 1,
        }
      : {}),
    ...(url.protocol === "https:" && !destinationIsIp
      ? {
          servername: destination.hostname,
          checkServerIdentity: (
            _hostname: string,
            certificate: Parameters<typeof checkServerIdentity>[1],
          ) => checkServerIdentity(destination.hostname, certificate),
        }
      : {}),
  };
}

export const requestPinnedProviderHttp: PinnedProviderHttpClient = async (
  url,
  init,
  destination,
) => {
  const options = buildPinnedProviderRequestOptions(url, init, destination);
  const method = options.method ?? "GET";
  const request = url.protocol === "https:" ? requestHttps : requestHttp;

  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      options,
      (incoming) => {
        try {
          const status = incoming.statusCode ?? 500;
          const hasBody = responseHasBody(method, status);
          if (!hasBody) incoming.resume();
          const body = hasBody
            ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
            : null;
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders(incoming.rawHeaders),
            }),
          );
        } catch (error) {
          reject(error);
          incoming.destroy();
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Provider protocol upgrades are unsupported."));
    });
    outgoing.end();
  });
};
