/*
 * GitHub resource proxy and repository browser.
 *
 * This file intentionally uses the classic Cloudflare Worker event API.  It
 * has no imports so it can be pasted directly into the Workers editor.
 */

// Edit these values in the dashboard when global bindings are not used.
// An env.CONFIG object with the same keys overrides this local configuration.
var Config = {
  PREFIX: "/",
  jsdelivr: 0,
  MAX_REDIRECTS: 4
};

var DEFAULT_PREFIX = Config.PREFIX;
var DEFAULT_MAX_REDIRECTS = Config.MAX_REDIRECTS;
var MAX_PROXY_URL_LENGTH = 4096;

var BLOCKED_REQUEST_HEADERS = {
  authorization: true,
  cookie: true,
  forwarded: true,
  "proxy-authorization": true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-proto": true,
  "x-real-ip": true,
  "cf-connecting-ip": true,
  "true-client-ip": true
};

var BLOCKED_RESPONSE_HEADERS = {
  "access-control-allow-origin": true,
  "access-control-allow-credentials": true,
  "clear-site-data": true,
  "content-security-policy": true,
  "content-security-policy-report-only": true,
  "set-cookie": true,
  authorization: true,
  "proxy-authenticate": true,
  "www-authenticate": true
};

var RESPONSE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
};

var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, Range",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin"
};

var ERROR_MESSAGES = {
  bad_request: "The request is invalid.",
  invalid_target: "The target URL is not an allowed GitHub resource.",
  invalid_repository_url: "A public GitHub repository URL is required.",
  repository_url_requires_api: "Repository pages are browsed through the project API.",
  invalid_contents_query: "The repository contents query is invalid.",
  method_not_allowed: "The HTTP method is not supported for this route.",
  not_found: "The requested route was not found.",
  proxy_fetch_failed: "The upstream resource could not be fetched.",
  unsafe_redirect: "The upstream redirect target is not allowed.",
  redirect_loop: "The upstream redirect looped.",
  redirect_limit: "The upstream redirected too many times.",
  invalid_redirect: "The upstream redirect was invalid.",
  github_api_error: "GitHub API request failed.",
  github_api_unavailable: "GitHub API is temporarily unavailable.",
  github_api_unauthorized: "GitHub API authorization failed.",
  github_api_forbidden: "GitHub API access was denied.",
  github_api_invalid_request: "GitHub API rejected the request.",
  github_rate_limited: "GitHub API rate limit exceeded.",
  repository_not_found: "The GitHub repository was not found or is private.",
  invalid_github_response: "GitHub returned an invalid response.",
  internal_error: "The request could not be completed."
};

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(String(value));
}

function normalizePrefix(value) {
  var prefix = value === undefined || value === null || value === "" ? DEFAULT_PREFIX : String(value);
  prefix = prefix.trim();
  if (!prefix) return DEFAULT_PREFIX;
  if (prefix.charAt(0) !== "/") prefix = "/" + prefix;
  if (prefix.charAt(prefix.length - 1) !== "/") prefix += "/";
  if (isControlCharacter(prefix) || /[?#]/.test(prefix)) return DEFAULT_PREFIX;
  // A prefix is a pathname, not a URL.  Keeping this conservative prevents a
  // configured prefix from changing the host or query portion of generated links.
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\-/]*\/$/.test(prefix)) return DEFAULT_PREFIX;
  return prefix;
}

function getRuntimeConfig(overrides) {
  var configured = {};

  // Config is a normal global in classic Workers.  globalThis is useful in
  // tests and in newer Workers, while typeof keeps this safe when absent.
  try {
    if (typeof Config !== "undefined" && Config && typeof Config === "object") {
      configured = Config;
    }
  } catch (_) {
    configured = {};
  }
  try {
    if (typeof globalThis !== "undefined" && globalThis.Config && typeof globalThis.Config === "object") {
      configured = globalThis.Config;
    }
  } catch (_) {
    // Ignore an unavailable globalThis in older runtimes.
  }
  if (overrides && typeof overrides === "object") {
    configured = Object.assign({}, configured, overrides);
  }

  var maxRedirects = Number(configured.MAX_REDIRECTS || configured.maxRedirects || DEFAULT_MAX_REDIRECTS);
  if (!isFinite(maxRedirects) || maxRedirects < 0) maxRedirects = DEFAULT_MAX_REDIRECTS;
  maxRedirects = Math.min(8, Math.floor(maxRedirects));

  return {
    PREFIX: normalizePrefix(configured.PREFIX),
    jsDelivr: configured.jsdelivr === true || configured.jsdelivr === 1 || configured.jsdelivr === "1" || configured.jsDelivr === true || configured.jsDelivr === 1 || configured.JSDELIVR === true,
    MAX_REDIRECTS: maxRedirects
  };
}

function getOrigin(request) {
  try {
    return new URL(request.url).origin;
  } catch (_) {
    return "";
  }
}

function isGithubWebHost(hostname) {
  var host = String(hostname || "").toLowerCase();
  return host === "github.com" || host === "www.github.com";
}

function isAllowedResourceHost(hostname) {
  var host = String(hostname || "").toLowerCase();
  if (
    host === "github.com" ||
    host === "www.github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "gist.github.com" ||
    host === "gist.githubusercontent.com" ||
    host === "codeload.github.com" ||
    host === "objects.githubusercontent.com" ||
    host === "github-releases.githubusercontent.com" ||
    host === "release-assets.githubusercontent.com" ||
    host === "github-cloud.s3.amazonaws.com" ||
    host === "cdn.jsdelivr.net"
  ) {
    return true;
  }
  // GitHub release downloads have used generated github-production-release-
  // asset hosts.  Match that exact label shape rather than all AWS hosts.
  return /^github-production-release-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(host);
}

function hasSafeUrlParts(parsed) {
  if (!parsed || parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  if (isControlCharacter(parsed.href) || parsed.href.length > MAX_PROXY_URL_LENGTH) return false;
  return true;
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return null;
  }
}

function pathSegments(pathname) {
  var raw = String(pathname || "");
  if (raw.charAt(0) === "/") raw = raw.slice(1);
  var pieces = raw.split("/");
  if (pieces.length && pieces[pieces.length - 1] === "") pieces.pop();
  if (!pieces.length) return [];
  var decoded = [];
  for (var i = 0; i < pieces.length; i += 1) {
    if (!pieces[i]) return null;
    var piece = decodeSegment(pieces[i]);
    if (piece === null || isControlCharacter(piece) || piece.indexOf("\\") !== -1 || piece === "." || piece === "..") return null;
    // An encoded slash would otherwise create an ambiguous path boundary.
    if (piece.indexOf("/") !== -1) return null;
    decoded.push(piece);
  }
  return decoded;
}

function isRepositoryPart(value, maxLength) {
  var text = String(value || "");
  return text.length > 0 && text.length <= (maxLength || 100) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) && text !== "." && text !== "..";
}

function parseRepositoryUrl(value) {
  if (value instanceof URL) value = value.toString();
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PROXY_URL_LENGTH) return null;
  if (isControlCharacter(value)) return null;

  var parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return null;
  }
  if (!hasSafeUrlParts(parsed) || !isGithubWebHost(parsed.hostname)) return null;
  if (parsed.search || parsed.hash) return null;
  var parts = pathSegments(parsed.pathname);
  if (!parts || parts.length !== 2) return null;
  var owner = parts[0];
  var repo = parts[1];
  if (repo.toLowerCase().slice(-4) === ".git") repo = repo.slice(0, -4);
  if (!isRepositoryPart(owner, 39) || !isRepositoryPart(repo, 100)) return null;
  return {
    owner: owner,
    repo: repo,
    canonical: "https://github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo),
    url: parsed
  };
}

function validateGithubRepoParts(parts) {
  return parts && parts.length >= 2 && isRepositoryPart(parts[0], 39) && isRepositoryPart(parts[1], 100);
}

function parseResourceTarget(value) {
  if (value instanceof URL) value = value.toString();
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PROXY_URL_LENGTH || isControlCharacter(value)) return null;

  var parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return null;
  }
  if (!hasSafeUrlParts(parsed) || !isAllowedResourceHost(parsed.hostname)) return null;
  if (parsed.hash) return null;

  var host = parsed.hostname.toLowerCase();
  var parts = pathSegments(parsed.pathname);
  if (!parts) return null;
  var result = { url: parsed, host: host, kind: null, owner: null, repo: null, ref: null, path: [] };

  if (isGithubWebHost(host)) {
    if (parts.length === 2 && validateGithubRepoParts(parts)) {
      result.kind = "repository";
      result.owner = parts[0];
      result.repo = parts[1];
      if (result.repo.toLowerCase().slice(-4) === ".git") result.repo = result.repo.slice(0, -4);
      return result;
    }
    if (parts.length < 3 || !validateGithubRepoParts(parts)) return null;
    result.owner = parts[0];
    result.repo = parts[1];
    var route = parts[2].toLowerCase();
    if (route === "blob" || route === "raw" || route === "resolve") {
      if (parts.length < 5) return null;
      result.kind = route === "blob" ? "blob" : "raw";
      var rawRef = parts.slice(3);
      if (rawRef[0] === "refs" && (rawRef[1] === "heads" || rawRef[1] === "tags") && rawRef.length >= 4) {
        result.ref = rawRef.slice(0, 3).join("/");
        result.path = rawRef.slice(3);
      } else {
        result.ref = rawRef[0];
        result.path = rawRef.slice(1);
      }
      if (!result.ref || !result.path.length) return null;
      return result;
    }
    // Git smart HTTP endpoints use these paths rather than /git/...:
    //   GET  /owner/repo.git/info/refs?service=git-upload-pack
    //   POST /owner/repo.git/git-upload-pack
    //   POST /owner/repo.git/git-receive-pack
    if (route === "info" && parts.length === 4 && parts[3].toLowerCase() === "refs") {
      result.kind = "git";
      result.gitOperation = "info/refs";
      result.path = parts.slice(2);
      return result;
    }
    if ((route === "git-upload-pack" || route === "git-receive-pack") && parts.length === 3) {
      result.kind = "git";
      result.gitOperation = route;
      result.path = parts.slice(2);
      return result;
    }
    if (route === "archive") {
      if (parts.length < 4) return null;
      result.kind = "archive";
      result.path = parts.slice(2);
      return result;
    }
    if (route === "tarball" || route === "zipball") {
      if (parts.length < 4) return null;
      result.kind = "archive";
      result.path = parts.slice(2);
      return result;
    }
    if (route === "releases") {
      if (parts.length < 5 || (parts[3].toLowerCase() !== "download" && parts[3].toLowerCase() !== "latest")) return null;
      result.kind = "release";
      result.path = parts.slice(2);
      return result;
    }
    if (route === "tags") {
      if (parts.length < 3) return null;
      result.kind = "tags";
      result.path = parts.slice(2);
      return result;
    }
    if (route === "git") {
      if (parts.length < 4) return null;
      result.kind = "git";
      result.path = parts.slice(2);
      return result;
    }
    return null;
  }

  if (host === "raw.githubusercontent.com") {
    if (parts.length < 4 || !validateGithubRepoParts(parts)) return null;
    result.kind = "raw";
    result.owner = parts[0];
    result.repo = parts[1];
    result.ref = parts[2];
    result.path = parts.slice(3);
    return result;
  }

  if (host === "gist.github.com" || host === "gist.githubusercontent.com") {
    if (parts.length < 1) return null;
    result.kind = "gist";
    result.path = parts;
    return result;
  }

  if (host === "codeload.github.com") {
    if (parts.length < 4 || !validateGithubRepoParts(parts)) return null;
    result.kind = "archive";
    result.owner = parts[0];
    result.repo = parts[1];
    result.path = parts.slice(2);
    return result;
  }

  if (host === "cdn.jsdelivr.net") {
    if (parts.length < 3 || parts[0].toLowerCase() !== "gh") return null;
    var repoAtRef = parts[2];
    var at = repoAtRef.indexOf("@");
    if (at <= 0 || at === repoAtRef.length - 1 || !validateGithubRepoParts([parts[1], repoAtRef.slice(0, at)])) return null;
    result.kind = "raw";
    result.owner = parts[1];
    result.repo = repoAtRef.slice(0, at);
    result.ref = repoAtRef.slice(at + 1);
    result.path = parts.slice(3);
    if (!result.path.length) return null;
    return result;
  }

  if (
    host === "objects.githubusercontent.com" ||
    host === "github-releases.githubusercontent.com" ||
    host === "release-assets.githubusercontent.com" ||
    host === "github-cloud.s3.amazonaws.com" ||
    /^github-production-release-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(host)
  ) {
    if (!parts.length) return null;
    result.kind = "release";
    result.path = parts;
    return result;
  }

  return null;
}

function isRepositoryTarget(value) {
  var parsed = parseResourceTarget(value);
  return !!parsed && parsed.kind === "repository";
}

function buildJsDelivrUrl(info) {
  if (!info || (info.kind !== "blob" && info.kind !== "raw") || !info.owner || !info.repo || !info.ref || !info.path || !info.path.length) return null;
  if (info.host === "cdn.jsdelivr.net") return null;
  var refParts = String(info.ref).split("/");
  var encodedRef = refParts.map(encodeURIComponent).join("/");
  var encodedPath = info.path.map(encodeURIComponent).join("/");
  return "https://cdn.jsdelivr.net/gh/" + encodeURIComponent(info.owner) + "/" + encodeURIComponent(info.repo) + "@" + encodedRef + "/" + encodedPath + (info.url.search || "");
}

function buildProxyUrl(request, target, config) {
  var origin = getOrigin(request);
  var runtime = config || getRuntimeConfig();
  return origin + runtime.PREFIX + String(target);
}

function extractProxyTarget(requestUrl, prefix) {
  var pathname = requestUrl.pathname;
  if (!pathname.startsWith(prefix)) return null;
  var remainder = pathname.slice(prefix.length);
  if (!remainder) return null;
  if (remainder.indexOf("https%3A") === 0 || remainder.indexOf("HTTPS%3A") === 0) {
    try {
      remainder = decodeURIComponent(remainder);
    } catch (_) {
      return null;
    }
  }
  // Some Worker/router combinations normalize the `//` following the embedded
  // scheme. Restore it before strict URL and host validation below.
  var schemeMatch = remainder.match(/^(https?):\/+/i);
  if (schemeMatch) remainder = schemeMatch[1].toLowerCase() + "://" + remainder.slice(schemeMatch[0].length);
  if (!/^https?:\/\//i.test(remainder)) return null;
  // The documented proxy format places the absolute URL after PREFIX.  A
  // target query becomes the outer query in an unencoded URL, so retain it.
  if (requestUrl.search && remainder.indexOf("?") === -1) remainder += requestUrl.search;
  return remainder;
}

function copyHeadersWithoutSensitive(source) {
  var output = new Headers();
  if (!source) return output;
  var add = function (name, value) {
    var lower = String(name).toLowerCase();
    if (BLOCKED_REQUEST_HEADERS[lower] || lower.indexOf("x-forwarded-") === 0 || lower === "host" || lower === "content-length") return;
    output.set(name, value);
  };
  if (typeof source.forEach === "function") {
    source.forEach(function (value, name) { add(name, value); });
  } else if (typeof source.entries === "function") {
    var iterator = source.entries();
    var step;
    while (!(step = iterator.next()).done) add(step.value[0], step.value[1]);
  } else if (isObject(source)) {
    Object.keys(source).forEach(function (name) { add(name, source[name]); });
  }
  return output;
}

function copyUpstreamHeaders(source) {
  var output = new Headers();
  if (source && typeof source.forEach === "function") {
    source.forEach(function (value, name) {
      if (!BLOCKED_RESPONSE_HEADERS[String(name).toLowerCase()]) output.set(name, value);
    });
  }
  return output;
}

function addCommonHeaders(headers, contentType) {
  Object.keys(CORS_HEADERS).forEach(function (name) { headers.set(name, CORS_HEADERS[name]); });
  Object.keys(RESPONSE_SECURITY_HEADERS).forEach(function (name) { headers.set(name, RESPONSE_SECURITY_HEADERS[name]); });
  if (contentType && !headers.has("Content-Type")) headers.set("Content-Type", contentType);
  return headers;
}

function responseWithHeaders(body, status, headers, contentType) {
  var output = headers instanceof Headers ? headers : new Headers(headers || {});
  addCommonHeaders(output, contentType);
  return new Response(body, { status: status, headers: output });
}

function jsonResponse(payload, status, request) {
  var headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  return responseWithHeaders(requestMethod(request) === "HEAD" ? null : JSON.stringify(payload), status || 200, headers);
}

function errorResponse(code, status, request) {
  var safeCode = ERROR_MESSAGES[code] ? code : "internal_error";
  var payload = { error: safeCode, message: ERROR_MESSAGES[safeCode] };
  return jsonResponse(payload, status || 400, request);
}

function optionsResponse() {
  return responseWithHeaders(null, 204, new Headers());
}

function redirectResponse(location, status) {
  var headers = new Headers({ Location: String(location) });
  return responseWithHeaders(null, status || 302, headers);
}

function requestMethod(request) {
  return String((request && request.method) || "GET").toUpperCase();
}

function getFetcher(env, options) {
  if (options && typeof options.fetch === "function") return options.fetch;
  if (env && typeof env.fetch === "function") return env.fetch;
  if (typeof fetch === "function") return fetch;
  return null;
}

function getToken(env) {
  if (env && typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim()) return env.GITHUB_TOKEN.trim();
  try {
    if (typeof GITHUB_TOKEN !== "undefined" && typeof GITHUB_TOKEN === "string" && GITHUB_TOKEN.trim()) return GITHUB_TOKEN.trim();
  } catch (_) {
    // The classic Worker global may not define a token.
  }
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.GITHUB_TOKEN === "string" && globalThis.GITHUB_TOKEN.trim()) return globalThis.GITHUB_TOKEN.trim();
  } catch (_) {
    // Ignore unavailable globals.
  }
  return "";
}

function makeGithubApiHeaders(env) {
  var headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-resource-proxy"
  });
  var token = getToken(env);
  if (token) headers.set("Authorization", "Bearer " + token);
  return headers;
}

function encodePathPart(value) {
  return encodeURIComponent(String(value));
}

function buildGithubContentsPath(owner, repo, path, ref) {
  var pathPart = "";
  if (path) {
    pathPart = "/" + String(path).split("/").map(encodePathPart).join("/");
  }
  return "/repos/" + encodePathPart(owner) + "/" + encodePathPart(repo) + "/contents" + pathPart + "?ref=" + encodeURIComponent(ref);
}

function buildGithubRepoPath(owner, repo, suffix) {
  return "/repos/" + encodePathPart(owner) + "/" + encodePathPart(repo) + (suffix || "");
}

function responseHeader(response, name) {
  try {
    return response && response.headers ? response.headers.get(name) : null;
  } catch (_) {
    return null;
  }
}

async function readJsonBody(response) {
  try {
    if (response && typeof response.json === "function") return await response.json();
    if (response && typeof response.text === "function") {
      var text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function isRateLimitResponse(status, headers, data) {
  if (status === 429) return true;
  var remaining = headers && typeof headers.get === "function" ? headers.get("x-ratelimit-remaining") : null;
  if (status === 403 && remaining === "0") return true;
  var message = data && typeof data.message === "string" ? data.message : "";
  return status === 403 && /rate\s*limit|abuse detection/i.test(message);
}

function githubErrorInfo(status, headers, data, critical) {
  if (isRateLimitResponse(status, headers, data)) return { code: "github_rate_limited", status: 429 };
  if (status === 401) return { code: "github_api_unauthorized", status: 401 };
  if (status === 403) return { code: "github_api_forbidden", status: 403 };
  if (status === 404 && critical) return { code: "repository_not_found", status: 404 };
  if (status === 404) return { code: "github_api_error", status: 404 };
  if (status === 422) return { code: "github_api_invalid_request", status: 422 };
  if (status >= 500) return { code: "github_api_unavailable", status: 502 };
  return { code: "github_api_error", status: status >= 400 && status < 500 ? status : 502 };
}

async function fetchGithubJson(apiPath, env, options) {
  var target = "https://api.github.com" + apiPath;
  var fetcher = getFetcher(env, options);
  if (!fetcher) return { ok: false, network: true, error: { code: "github_api_unavailable", status: 502 } };
  var init = { method: "GET", headers: makeGithubApiHeaders(env), redirect: "manual" };
  try {
    var response = await fetcher(target, init);
    var data = await readJsonBody(response);
    if (!response || response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response ? response.status : 502,
        headers: response ? response.headers : null,
        data: data,
        error: githubErrorInfo(response ? response.status : 502, response ? response.headers : null, data, !!(options && options.critical))
      };
    }
    return { ok: true, status: response.status, headers: response.headers, data: data };
  } catch (_) {
    return { ok: false, network: true, error: { code: "github_api_unavailable", status: 502 } };
  }
}

function mapRepository(value) {
  if (!isObject(value)) return null;
  var owner = isObject(value.owner) ? value.owner : {};
  var license = isObject(value.license) ? value.license : null;
  return {
    id: typeof value.id === "number" ? value.id : null,
    full_name: typeof value.full_name === "string" ? value.full_name : null,
    name: typeof value.name === "string" ? value.name : null,
    owner: { login: typeof owner.login === "string" ? owner.login : null },
    html_url: typeof value.html_url === "string" ? value.html_url : null,
    tarball_url: typeof value.tarball_url === "string" ? value.tarball_url : null,
    zipball_url: typeof value.zipball_url === "string" ? value.zipball_url : null,
    description: typeof value.description === "string" ? value.description : null,
    default_branch: typeof value.default_branch === "string" ? value.default_branch : null,
    language: typeof value.language === "string" ? value.language : null,
    stargazers_count: typeof value.stargazers_count === "number" ? value.stargazers_count : 0,
    forks_count: typeof value.forks_count === "number" ? value.forks_count : 0,
    open_issues_count: typeof value.open_issues_count === "number" ? value.open_issues_count : 0,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
    private: value.private === true,
    archived: value.archived === true,
    license: license ? {
      spdx_id: typeof license.spdx_id === "string" ? license.spdx_id : null,
      name: typeof license.name === "string" ? license.name : null
    } : null
  };
}

function safeProxyUrl(request, target, config) {
  var info = parseResourceTarget(target);
  if (!info || info.kind === "repository") return null;
  return buildProxyUrl(request, info.url.toString(), config);
}

function mapRelease(value, request, config) {
  if (!isObject(value)) return null;
  var assets = Array.isArray(value.assets) ? value.assets.slice(0, 50).map(function (asset) {
    if (!isObject(asset)) return null;
    var browserUrl = typeof asset.browser_download_url === "string" ? asset.browser_download_url : null;
    var proxyUrl = browserUrl ? safeProxyUrl(request, browserUrl, config) : null;
    return {
      id: typeof asset.id === "number" ? asset.id : null,
      name: typeof asset.name === "string" ? asset.name : null,
      label: typeof asset.label === "string" ? asset.label : null,
      size: typeof asset.size === "number" ? asset.size : 0,
      download_count: typeof asset.download_count === "number" ? asset.download_count : 0,
      browser_download_url: browserUrl,
      proxy_url: proxyUrl
    };
  }).filter(Boolean) : [];
  return {
    id: typeof value.id === "number" ? value.id : null,
    name: typeof value.name === "string" ? value.name : null,
    tag_name: typeof value.tag_name === "string" ? value.tag_name : null,
    html_url: typeof value.html_url === "string" ? value.html_url : null,
    published_at: typeof value.published_at === "string" ? value.published_at : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    prerelease: value.prerelease === true,
    draft: value.draft === true,
    assets: assets
  };
}

function mapContent(value, request, config) {
  if (!isObject(value)) return null;
  var downloadUrl = typeof value.download_url === "string" ? value.download_url : null;
  return {
    type: typeof value.type === "string" ? value.type : null,
    name: typeof value.name === "string" ? value.name : null,
    path: typeof value.path === "string" ? value.path : null,
    size: typeof value.size === "number" ? value.size : 0,
    sha: typeof value.sha === "string" ? value.sha : null,
    html_url: typeof value.html_url === "string" ? value.html_url : null,
    download_url: downloadUrl,
    proxy_url: downloadUrl ? safeProxyUrl(request, downloadUrl, config) : null
  };
}

function mapReadme(value, request, config) {
  if (!isObject(value)) return null;
  var downloadUrl = typeof value.download_url === "string" ? value.download_url : null;
  return {
    name: typeof value.name === "string" ? value.name : null,
    path: typeof value.path === "string" ? value.path : null,
    size: typeof value.size === "number" ? value.size : 0,
    sha: typeof value.sha === "string" ? value.sha : null,
    encoding: typeof value.encoding === "string" ? value.encoding : null,
    html_url: typeof value.html_url === "string" ? value.html_url : null,
    download_url: downloadUrl,
    proxy_url: downloadUrl ? safeProxyUrl(request, downloadUrl, config) : null
  };
}

function warningFor(resource, result) {
  var error = result && result.error ? result.error : { code: "github_api_error", status: 502 };
  return { resource: resource, code: error.code, status: error.status };
}

async function handleRepoApi(request, env, config) {
  var requestUrl = new URL(request.url);
  var rawUrl = requestUrl.searchParams.get("url");
  var repository = parseRepositoryUrl(rawUrl || "");
  if (!repository) return errorResponse("invalid_repository_url", 400, request);

  var repoPath = buildGithubRepoPath(repository.owner, repository.repo);
  var repoResult = await fetchGithubJson(repoPath, env, { critical: true });
  if (!repoResult.ok) return errorResponse(repoResult.error.code, repoResult.error.status, request);
  var mappedRepository = mapRepository(repoResult.data);
  if (!mappedRepository) return errorResponse("invalid_github_response", 502, request);
  var branch = mappedRepository.default_branch || "HEAD";

  var results = await Promise.all([
    fetchGithubJson(buildGithubRepoPath(repository.owner, repository.repo, "/releases?per_page=20"), env, { critical: false }),
    fetchGithubJson(buildGithubContentsPath(repository.owner, repository.repo, "", branch), env, { critical: false }),
    fetchGithubJson(buildGithubRepoPath(repository.owner, repository.repo, "/readme?ref=" + encodeURIComponent(branch)), env, { critical: false })
  ]);
  var warnings = [];
  var releasesResult = results[0];
  var contentsResult = results[1];
  var readmeResult = results[2];
  var releases = [];
  var contents = [];
  var readme = null;

  if (releasesResult.ok && Array.isArray(releasesResult.data)) {
    releases = releasesResult.data.slice(0, 20).map(function (release) { return mapRelease(release, request, config); }).filter(Boolean);
  } else if (!releasesResult.ok) {
    warnings.push(warningFor("releases", releasesResult));
  } else {
    warnings.push({ resource: "releases", code: "invalid_github_response", status: 502 });
  }

  if (contentsResult.ok && Array.isArray(contentsResult.data)) {
    contents = contentsResult.data.map(function (entry) { return mapContent(entry, request, config); }).filter(Boolean);
  } else if (!contentsResult.ok) {
    warnings.push(warningFor("contents", contentsResult));
  } else {
    warnings.push({ resource: "contents", code: "invalid_github_response", status: 502 });
  }

  if (readmeResult.ok && isObject(readmeResult.data)) {
    readme = mapReadme(readmeResult.data, request, config);
  } else if (!readmeResult.ok) {
    warnings.push(warningFor("readme", readmeResult));
  } else {
    warnings.push({ resource: "readme", code: "invalid_github_response", status: 502 });
  }

  return jsonResponse({ repository: mappedRepository, releases: releases, contents: contents, readme: readme, warnings: warnings }, 200, request);
}

function parseContentsQuery(requestUrl) {
  var owner = requestUrl.searchParams.get("owner") || "";
  var repo = requestUrl.searchParams.get("repo") || "";
  var path = requestUrl.searchParams.get("path") || "";
  var ref = requestUrl.searchParams.get("ref") || "";
  if (!isRepositoryPart(owner, 39) || !isRepositoryPart(repo, 100)) return null;
  if (repo.toLowerCase().slice(-4) === ".git") repo = repo.slice(0, -4);
  if (path.length > 2048 || isControlCharacter(path) || path.indexOf("\\") !== -1 || path.charAt(0) === "/") return null;
  if (path) {
    var pathParts = path.split("/");
    for (var i = 0; i < pathParts.length; i += 1) {
      if (!pathParts[i] || pathParts[i] === "." || pathParts[i] === "..") return null;
    }
  }
  if (!ref || ref.length > 256 || isControlCharacter(ref) || ref.indexOf("\\") !== -1 || ref.split("/").some(function (part) { return !part || part === "." || part === ".."; })) return null;
  return { owner: owner, repo: repo, path: path, ref: ref };
}

async function handleContentsApi(request, env, config) {
  var requestUrl = new URL(request.url);
  var query = parseContentsQuery(requestUrl);
  if (!query) return errorResponse("invalid_contents_query", 400, request);
  var result = await fetchGithubJson(buildGithubContentsPath(query.owner, query.repo, query.path, query.ref), env, { critical: true });
  if (!result.ok) return errorResponse(result.error.code, result.error.status, request);
  var values = Array.isArray(result.data) ? result.data : [result.data];
  var contents = values.map(function (entry) { return mapContent(entry, request, config); }).filter(Boolean);
  if (!contents.length && result.data !== null) return errorResponse("invalid_github_response", 502, request);
  return jsonResponse({ contents: contents, warnings: [] }, 200, request);
}

async function fetchProxyResource(request, env, config, targetInfo) {
  var fetcher = getFetcher(env);
  if (!fetcher) return errorResponse("proxy_fetch_failed", 502, request);
  var current = targetInfo.url.toString();
  var seen = {};
  var redirects = 0;
  var method = requestMethod(request);
  var requestHeaders = copyHeadersWithoutSensitive(request.headers);
  var requestBody;

  if (method === "POST") {
    try {
      // Buffer the verified git request once so a 307/308 redirect can safely
      // replay the body.  GET and HEAD never receive an init.body property.
      requestBody = request && typeof request.arrayBuffer === "function" ? await request.arrayBuffer() : request.body;
    } catch (_) {
      return errorResponse("proxy_fetch_failed", 502, request);
    }
  }

  while (true) {
    var parsed = parseResourceTarget(current);
    if (!parsed || parsed.kind === "repository") return errorResponse("unsafe_redirect", 502, request);
    var key = parsed.url.toString();
    if (seen[key]) return errorResponse("redirect_loop", 502, request);
    seen[key] = true;
    var init = { method: method, headers: requestHeaders, redirect: "manual" };
    if (method === "POST") init.body = requestBody;
    var upstream;
    try {
      // GET/HEAD intentionally have no body.  This also avoids forwarding a
      // request stream that has already been consumed by the Worker runtime.
      upstream = await fetcher(key, init);
    } catch (_) {
      return errorResponse("proxy_fetch_failed", 502, request);
    }
    if (!upstream) return errorResponse("proxy_fetch_failed", 502, request);
    var status = Number(upstream.status || 0);
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      if (redirects >= config.MAX_REDIRECTS) return errorResponse("redirect_limit", 502, request);
      var location = responseHeader(upstream, "location");
      if (!location || isControlCharacter(location)) return errorResponse("invalid_redirect", 502, request);
      var next;
      try {
        next = new URL(location, key);
      } catch (_) {
        return errorResponse("invalid_redirect", 502, request);
      }
      if (!hasSafeUrlParts(next) || !isAllowedResourceHost(next.hostname)) return errorResponse("unsafe_redirect", 502, request);
      var nextInfo = parseResourceTarget(next.toString());
      if (!nextInfo || nextInfo.kind === "repository") return errorResponse("unsafe_redirect", 502, request);
      if (method === "POST" && (nextInfo.kind !== "git" || (nextInfo.gitOperation !== "git-upload-pack" && nextInfo.gitOperation !== "git-receive-pack"))) return errorResponse("unsafe_redirect", 502, request);
      if (method !== "POST" && nextInfo.kind === "git" && nextInfo.gitOperation && nextInfo.gitOperation !== "info/refs") return errorResponse("unsafe_redirect", 502, request);
      current = next.toString();
      redirects += 1;
      continue;
    }
    var headers = copyUpstreamHeaders(upstream.headers);
    addCommonHeaders(headers);
    var body = method === "HEAD" || status === 204 || status === 205 || status === 304 ? null : upstream.body;
    return new Response(body, { status: status || 502, statusText: upstream.statusText || "", headers: headers });
  }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * Render the standalone repository browser and resource proxy interface.
 * The Worker passes its normalized runtime config as the second argument.
 */
function generateHomePage(input, runtimeConfig) {
  var configuredPrefix = runtimeConfig && typeof runtimeConfig.PREFIX === "string"
    ? runtimeConfig.PREFIX.trim()
    : (typeof PREFIX === "string" ? PREFIX.trim() : "/");
  configuredPrefix = configuredPrefix.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  var prefixCore = configuredPrefix.replace(/^\/+|\/+$/g, "");
  var normalizedPrefix = prefixCore ? "/" + prefixCore + "/" : "/";
  var clientConfig = jsonForScript({ prefix: normalizedPrefix });

  return String.raw`<!doctype html>
<html lang="zh-CN" data-theme="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="description" content="浏览公开 GitHub 仓库，并为 Release、Raw、Archive 与 Gist 资源生成代理链接。">
  <title>Passage — GitHub 资源中转与仓库浏览</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f6f8fa;
      --page-deep: #eef1f4;
      --surface: #ffffff;
      --surface-strong: #ffffff;
      --surface-soft: #f6f8fa;
      --ink: #1f2328;
      --ink-soft: #424a53;
      --muted: #656d76;
      --line: #d0d7de;
      --line-strong: #afb8c1;
      --accent: #1f883d;
      --accent-strong: #1a7f37;
      --accent-ink: #ffffff;
      --blue: #0969da;
      --blue-soft: #ddf4ff;
      --success: #1a7f37;
      --success-soft: #dafbe1;
      --warning: #9a6700;
      --warning-soft: #fff8c5;
      --danger: #cf222e;
      --danger-soft: #ffebe9;
      --shadow-sm: 0 1px 2px rgba(31, 35, 40, .08);
      --shadow: 0 16px 42px rgba(31, 35, 40, .10);
      --radius-lg: 20px;
      --radius: 14px;
      --radius-sm: 10px;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-family: var(--sans);
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --page: #0d1117;
      --page-deep: #010409;
      --surface: #161b22;
      --surface-strong: #21262d;
      --surface-soft: #1c2128;
      --ink: #f0f6fc;
      --ink-soft: #c9d1d9;
      --muted: #8b949e;
      --line: #30363d;
      --line-strong: #484f58;
      --accent: #238636;
      --accent-strong: #2ea043;
      --accent-ink: #ffffff;
      --blue: #58a6ff;
      --blue-soft: #172a46;
      --success: #3fb950;
      --success-soft: #183622;
      --warning: #d29922;
      --warning-soft: #3b2e12;
      --danger: #ff7b72;
      --danger-soft: #431c21;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, .22);
      --shadow: 0 24px 70px rgba(0, 0, 0, .35);
    }

    @media (prefers-color-scheme: dark) {
      :root[data-theme="auto"] {
        color-scheme: dark;
        --page: #0d1117;
        --page-deep: #010409;
        --surface: #161b22;
        --surface-strong: #21262d;
        --surface-soft: #1c2128;
        --ink: #f0f6fc;
        --ink-soft: #c9d1d9;
        --muted: #8b949e;
        --line: #30363d;
        --line-strong: #484f58;
        --accent: #238636;
        --accent-strong: #2ea043;
        --accent-ink: #ffffff;
        --blue: #58a6ff;
        --blue-soft: #172a46;
        --success: #3fb950;
        --success-soft: #183622;
        --warning: #d29922;
        --warning-soft: #3b2e12;
        --danger: #ff7b72;
        --danger-soft: #431c21;
        --shadow-sm: 0 1px 2px rgba(0, 0, 0, .22);
        --shadow: 0 24px 70px rgba(0, 0, 0, .35);
      }
    }

    * { box-sizing: border-box; }
    html { min-width: 300px; scroll-behavior: smooth; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 78% 8%, color-mix(in srgb, var(--blue) 8%, transparent), transparent 28rem),
        radial-gradient(circle at 18% 20%, color-mix(in srgb, var(--success) 6%, transparent), transparent 24rem),
        var(--page);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      position: fixed;
      z-index: -1;
      inset: 0;
      background-image: linear-gradient(color-mix(in srgb, var(--line) 24%, transparent) 1px, transparent 1px);
      background-size: 100% 72px;
      mask-image: linear-gradient(to bottom, rgba(0, 0, 0, .3), transparent 620px);
      content: "";
      pointer-events: none;
    }
    button, input { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button { color: inherit; }
    a { color: var(--blue); text-underline-offset: 3px; }
    a:hover { color: var(--ink); }
    :focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
    [hidden] { display: none !important; }
    ::selection { color: var(--ink); background: var(--blue-soft); }

    .skip-link {
      position: fixed;
      z-index: 100;
      top: 12px;
      left: 12px;
      padding: 10px 14px;
      border-radius: 10px;
      color: var(--accent-ink);
      background: var(--accent);
      font-weight: 800;
      transform: translateY(-150%);
    }
    .skip-link:focus { transform: translateY(0); }

    .shell {
      width: min(1240px, calc(100% - 48px));
      margin-inline: auto;
    }
    .icon-button {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow-sm);
      cursor: pointer;
      font-size: 1rem;
    }
    .icon-button:hover { border-color: var(--line-strong); background: var(--surface-strong); }

    main { padding: clamp(46px, 5vw, 68px) 0 80px; }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, .82fr) minmax(540px, 1.18fr);
      gap: clamp(44px, 6vw, 84px);
      align-items: center;
    }
    .hero-grid > * { min-width: 0; }
    .hero-intro {
      max-width: 540px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 20px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: color-mix(in srgb, var(--surface) 76%, transparent);
      font-family: var(--mono);
      font-size: .68rem;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 13%, transparent);
      content: "";
    }
    h1, h2, h3, p { overflow-wrap: anywhere; }
    h1 {
      max-width: 600px;
      margin: 0;
      font-size: clamp(3rem, 4.8vw, 4.5rem);
      font-weight: 760;
      line-height: 1.04;
      letter-spacing: -.055em;
      text-wrap: balance;
    }
    .highlight {
      display: inline-block;
      color: var(--blue);
      white-space: nowrap;
    }
    .hero-copy {
      max-width: 530px;
      margin: 22px 0 0;
      color: var(--ink-soft);
      font-size: clamp(.98rem, 1.5vw, 1.08rem);
    }
    .hero-points {
      display: flex;
      flex-wrap: wrap;
      gap: 9px 16px;
      margin: 25px 0 0;
      padding: 0;
      list-style: none;
    }
    .hero-point {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: .81rem;
    }
    .hero-point::before {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: var(--success);
      background: var(--success-soft);
      content: "✓";
      font-size: .68rem;
      font-weight: 900;
    }
    .command-panel {
      position: relative;
      overflow: hidden;
      padding: clamp(24px, 3vw, 32px);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--surface) 96%, transparent);
      box-shadow: var(--shadow);
    }
    .command-panel::before {
      position: absolute;
      inset: 0 0 auto;
      height: 3px;
      background: linear-gradient(90deg, var(--success), var(--blue));
      content: "";
    }
    .command-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 22px;
    }
    .command-kicker {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .66rem;
      font-weight: 700;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .command-head h2 {
      margin: 0;
      font-size: clamp(1.35rem, 2.4vw, 1.75rem);
      line-height: 1.18;
      letter-spacing: -.035em;
    }
    .command-tools {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 11px;
    }
    .command-note {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .67rem;
    }
    .command-note::before { color: var(--success); content: "●"; font-size: .58rem; }

    .command-area {
      margin: 0;
      padding: 6px;
      border: 1px solid var(--line-strong);
      border-radius: 13px;
      background: var(--surface-strong);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--surface) 50%, transparent), var(--shadow-sm);
    }
    .url-form {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      gap: 6px;
      align-items: center;
    }
    .form-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .input-prefix {
      padding-left: 9px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .86rem;
      font-weight: 800;
      user-select: none;
    }
    .url-input {
      width: 100%;
      min-width: 0;
      height: 48px;
      padding: 0 7px;
      border: 0;
      border-radius: 8px;
      color: var(--ink);
      background: transparent;
      outline: none;
    }
    .url-input::placeholder { color: var(--muted); opacity: .78; }
    .url-input[aria-invalid="true"] { background: var(--danger-soft); }
    .clear-button {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 10px;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
      font-size: 1.2rem;
    }
    .clear-button:hover { color: var(--ink); background: var(--surface-soft); }
    .primary-button, .secondary-button, .text-button {
      border-radius: 11px;
      cursor: pointer;
      font-weight: 800;
    }
    .primary-button {
      min-height: 48px;
      padding: 0 18px;
      border: 1px solid color-mix(in srgb, var(--accent) 72%, #000000);
      color: var(--accent-ink);
      background: var(--accent);
      box-shadow: 0 1px 0 rgba(31, 35, 40, .12), inset 0 1px 0 rgba(255, 255, 255, .14);
      white-space: nowrap;
      transition: background .16s ease, border-color .16s ease;
    }
    .primary-button:hover { border-color: var(--accent-strong); background: var(--accent-strong); }
    .primary-button:active { filter: brightness(.92); }
    .primary-button:disabled { cursor: wait; opacity: .65; }
    .command-meta {
      padding: 10px 2px 0;
    }
    .form-hint {
      min-height: 1.5em;
      margin: 0;
      color: var(--muted);
      font-size: .83rem;
    }
    .form-hint.error { color: var(--danger); font-weight: 700; }
    .form-hint.success { color: var(--success); font-weight: 700; }
    .input-kind {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      min-height: 26px;
      padding: 3px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--surface-soft);
      font-family: var(--mono);
      font-size: .67rem;
      font-weight: 800;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .input-kind.valid { color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, var(--line)); background: var(--success-soft); }
    .quick-links {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .quick-label { margin-right: 2px; color: var(--muted); font-size: .76rem; }
    .example-button {
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--ink-soft);
      background: var(--surface-soft);
      cursor: pointer;
      font-family: var(--mono);
      font-size: .72rem;
    }
    .example-button:hover { border-color: var(--line-strong); color: var(--ink); background: var(--surface-strong); }
    kbd {
      padding: 2px 5px;
      border: 1px solid var(--line);
      border-bottom-width: 2px;
      border-radius: 5px;
      color: var(--muted);
      background: var(--surface-soft);
      font-family: var(--mono);
      font-size: .68rem;
    }

    .feature-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 64px;
    }
    .feature-item {
      min-height: 128px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--surface) 78%, transparent);
    }
    .feature-index {
      display: block;
      margin-bottom: 14px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .67rem;
    }
    .feature-item strong { display: block; font-size: .95rem; }
    .feature-item p { margin: 6px 0 0; color: var(--muted); font-size: .86rem; }

    .results { margin-top: 48px; scroll-margin-top: 92px; }
    .panel {
      margin-top: 18px;
      padding: clamp(20px, 3.2vw, 34px);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--surface) 96%, transparent);
      box-shadow: var(--shadow);
      scroll-margin-top: 92px;
    }
    .panel-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 22px;
      margin-bottom: 24px;
    }
    .section-kicker {
      display: block;
      margin-bottom: 7px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .68rem;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .panel h2 {
      margin: 0;
      font-size: clamp(1.4rem, 3.4vw, 2.1rem);
      line-height: 1.1;
      letter-spacing: -.045em;
    }
    .panel h3 { margin: 0; font-size: 1rem; }
    .section-caption { margin: 7px 0 0; color: var(--muted); font-size: .87rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 27px;
      padding: 3px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--surface-soft);
      font-family: var(--mono);
      font-size: .67rem;
      font-weight: 800;
      letter-spacing: .03em;
      white-space: nowrap;
    }
    .badge.success { color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, var(--line)); background: var(--success-soft); }
    .badge.warning { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 38%, var(--line)); background: var(--warning-soft); }
    .badge.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); background: var(--danger-soft); }

    .status-panel { text-align: center; }
    .status-orbit {
      position: relative;
      width: 52px;
      height: 52px;
      margin: 0 auto 18px;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
    }
    .status-orbit::before {
      position: absolute;
      top: -4px;
      left: 50%;
      width: 10px;
      height: 10px;
      border: 2px solid var(--surface);
      border-radius: 50%;
      background: var(--accent-strong);
      content: "";
      transform-origin: 0 30px;
      animation: orbit 1s linear infinite;
    }
    @keyframes orbit { to { transform: rotate(360deg); } }
    .status-title { margin: 0; font-size: 1.13rem; font-weight: 850; }
    .status-copy { max-width: 650px; margin: 7px auto 0; color: var(--muted); }
    .status-actions { display: flex; justify-content: center; gap: 10px; margin-top: 18px; }
    .skeleton-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 25px; }
    .skeleton {
      height: 68px;
      border-radius: 12px;
      background: linear-gradient(100deg, var(--surface-soft) 20%, color-mix(in srgb, var(--line) 65%, var(--surface)) 45%, var(--surface-soft) 70%);
      background-size: 230% 100%;
      animation: shimmer 1.35s ease infinite;
    }
    @keyframes shimmer { to { background-position-x: -230%; } }
    .warning-panel { border-color: color-mix(in srgb, var(--warning) 42%, var(--line)); background: var(--warning-soft); box-shadow: none; }
    .warning-list { margin: 10px 0 0; padding-left: 21px; }
    .warning-list li + li { margin-top: 6px; }

    .proxy-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
    .url-card {
      min-width: 0;
      padding: 17px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .field-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 9px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: .69rem;
      font-weight: 800;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .output-input {
      width: 100%;
      min-width: 0;
      height: 42px;
      padding: 0;
      border: 0;
      color: var(--ink);
      background: transparent;
      outline: none;
      font-family: var(--mono);
      font-size: .8rem;
      text-overflow: ellipsis;
    }
    .proxy-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
    .link-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
    .button-link, .secondary-link {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 0 14px;
      border-radius: 11px;
      font-size: .86rem;
      font-weight: 800;
      text-decoration: none;
    }
    .button-link { border: 1px solid color-mix(in srgb, var(--accent) 72%, #000000); color: var(--accent-ink); background: var(--accent); box-shadow: var(--shadow-sm); }
    .button-link:hover { border-color: var(--accent-strong); color: var(--accent-ink); background: var(--accent-strong); }
    .secondary-link { border: 1px solid var(--line); color: var(--ink-soft); background: var(--surface-strong); }
    .secondary-link:hover { border-color: var(--line-strong); color: var(--ink); }
    .secondary-button {
      min-height: 40px;
      padding: 0 13px;
      border: 1px solid var(--line);
      color: var(--ink);
      background: var(--surface-strong);
    }
    .secondary-button:hover { border-color: var(--line-strong); background: var(--surface-soft); }

    .repo-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 26px;
      align-items: start;
    }
    .repo-name-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .repo-description { max-width: 760px; margin: 13px 0 0; color: var(--ink-soft); font-size: 1rem; }
    .repo-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      margin-top: 27px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
      overflow: hidden;
    }
    .metric {
      min-width: 0;
      padding: 17px;
      border-left: 1px solid var(--line);
    }
    .metric:first-child { border-left: 0; }
    .metric-label { display: block; margin-bottom: 7px; color: var(--muted); font-family: var(--mono); font-size: .63rem; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
    .metric-value { display: block; overflow-wrap: anywhere; font-size: .93rem; font-weight: 820; }
    .clone-box {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      margin-top: 14px;
      padding: 12px 13px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface-soft);
    }
    .clone-label { color: var(--muted); font-family: var(--mono); font-size: .66rem; font-weight: 800; text-transform: uppercase; }
    .clone-command { min-width: 0; overflow: hidden; color: var(--ink-soft); font-family: var(--mono); font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }

    .release-list { display: grid; gap: 10px; }
    .release-card {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .release-card[open] { background: color-mix(in srgb, var(--surface-soft) 76%, var(--surface-strong)); }
    .release-summary {
      padding: 18px 19px;
      list-style: none;
      cursor: pointer;
      transition: background .16s ease;
    }
    .release-summary::-webkit-details-marker { display: none; }
    .release-summary::marker { content: ""; }
    .release-summary:focus-visible { outline-offset: -4px; }
    .release-summary:hover { background: color-mix(in srgb, var(--surface-strong) 72%, transparent); }
    .release-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .release-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .release-meta { margin: 6px 0 0; color: var(--muted); font-family: var(--mono); font-size: .72rem; }
    .release-summary-side { display: flex; align-items: center; gap: 9px; }
    .release-chevron {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--muted);
      background: var(--surface-strong);
      font-size: 1rem;
      font-weight: 700;
    }
    .release-chevron::before { content: "＋"; }
    .release-card[open] .release-chevron::before { content: "−"; }
    .release-body { padding: 0 19px 19px; border-top: 1px solid var(--line); }
    .release-body-actions { display: flex; justify-content: flex-end; padding-top: 12px; }
    .release-empty { margin: 14px 0 0; color: var(--muted); font-size: .84rem; }
    .asset-list { display: grid; gap: 7px; margin: 14px 0 0; padding: 0; list-style: none; }
    .asset-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 13px;
      padding: 10px 12px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: var(--surface-strong);
    }
    .asset-row:hover { border-color: var(--line); }
    .asset-name { min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: .78rem; font-weight: 700; }
    .asset-size { color: var(--muted); font-family: var(--mono); font-size: .68rem; white-space: nowrap; }
    .asset-link { font-size: .79rem; font-weight: 800; white-space: nowrap; }

    .file-tools { display: flex; align-items: center; gap: 9px; }
    .file-filter {
      width: min(230px, 34vw);
      height: 38px;
      padding: 0 11px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--ink);
      background: var(--surface-strong);
      font-size: .8rem;
    }
    .file-browser { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-soft); }
    .file-list { margin: 0; padding: 0; list-style: none; }
    .file-list .file-list { margin-left: 27px; border-left: 1px solid var(--line); }
    .file-row {
      min-height: 51px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 7px 13px;
      border-top: 1px solid var(--line);
      background: color-mix(in srgb, var(--surface-strong) 64%, transparent);
    }
    .file-list > .file-node:first-child > .file-row { border-top: 0; }
    .file-list .file-list > .file-node > .file-row { border-top: 1px solid var(--line); }
    .file-row:hover { background: var(--surface-strong); }
    .file-main { min-width: 0; display: flex; align-items: center; gap: 9px; }
    .file-kind {
      flex: 0 0 auto;
      min-width: 34px;
      padding: 2px 4px;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--muted);
      background: var(--surface-soft);
      font-family: var(--mono);
      font-size: .58rem;
      font-weight: 850;
      text-align: center;
      text-transform: uppercase;
    }
    .file-kind.directory { color: var(--warning); background: var(--warning-soft); }
    .directory-toggle {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 6px;
      border: 0;
      border-radius: 8px;
      color: var(--ink);
      background: transparent;
      cursor: pointer;
      text-align: left;
    }
    .directory-toggle:hover { color: var(--blue); background: var(--blue-soft); }
    .disclosure { width: 1em; color: var(--muted); transition: transform .16s ease; }
    .directory-toggle[aria-expanded="true"] .disclosure { transform: rotate(90deg); }
    .file-name { min-width: 0; overflow-wrap: anywhere; font-size: .87rem; font-weight: 700; }
    .file-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; font-size: .77rem; }
    .file-placeholder { padding: 13px 16px 13px 48px; color: var(--muted); border-top: 1px solid var(--line); font-size: .84rem; }
    .file-error { color: var(--danger); }
    .text-button { margin-left: 8px; padding: 4px 7px; border: 0; color: var(--blue); background: transparent; text-decoration: underline; text-underline-offset: 3px; }

    .readme-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 22px;
      align-items: center;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .readme-card p { max-width: 720px; margin: 7px 0 0; color: var(--muted); font-size: .86rem; }
    .empty-state { padding: 30px; color: var(--muted); text-align: center; border: 1px dashed var(--line-strong); border-radius: var(--radius); background: var(--surface-soft); }

    footer { padding: 28px 0 42px; color: var(--muted); font-size: .76rem; }
    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding-top: 22px;
      border-top: 1px solid var(--line);
    }
    .footer-code { font-family: var(--mono); }

    @media (max-width: 1100px) {
      .hero-grid { grid-template-columns: 1fr; }
      .hero-intro { max-width: 720px; }
      .hero-copy { max-width: 680px; }
      .overview-grid { grid-template-columns: repeat(3, 1fr); }
      .metric:nth-child(4) { border-left: 0; border-top: 1px solid var(--line); }
      .metric:nth-child(5), .metric:nth-child(6) { border-top: 1px solid var(--line); }
    }

    @media (max-width: 720px) {
      .shell { width: calc(100% - 24px); }
      main { padding-top: 40px; }
      .hero-grid { gap: 36px; }
      h1 { font-size: clamp(2.65rem, 12vw, 4rem); }
      .command-panel { padding: 22px; }
      .url-form { grid-template-columns: auto minmax(0, 1fr) auto; }
      .form-actions { grid-column: 1 / -1; }
      .form-actions .primary-button { flex: 1 1 auto; }
      .feature-strip { grid-template-columns: 1fr; margin-top: 48px; }
      .feature-item { min-height: 0; }
      .proxy-grid { grid-template-columns: 1fr; }
      .repo-top { grid-template-columns: 1fr; }
      .repo-actions { justify-content: flex-start; }
      .release-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
      .release-summary-side { justify-content: flex-end; }
      .asset-row { grid-template-columns: minmax(0, 1fr) auto; }
      .asset-link { grid-column: 1 / -1; justify-self: start; }
      .file-row { grid-template-columns: 1fr; gap: 3px; }
      .file-actions { justify-content: flex-start; padding-left: 44px; }
      .readme-card { grid-template-columns: 1fr; }
      .footer-inner { display: grid; }
    }

    @media (max-width: 520px) {
      .command-head { gap: 12px; }
      .command-tools { margin-left: auto; }
      .command-note { display: none; }
      .panel { border-radius: 21px; }
      .panel-header { display: grid; }
      .panel-header > .badge { justify-self: start; }
      .overview-grid { grid-template-columns: repeat(2, 1fr); }
      .metric:nth-child(odd) { border-left: 0; }
      .metric:nth-child(n+3) { border-top: 1px solid var(--line); }
      .metric:nth-child(4) { border-left: 1px solid var(--line); }
      .skeleton-grid { grid-template-columns: 1fr 1fr; }
      .clone-box { grid-template-columns: 1fr auto; }
      .clone-label { grid-column: 1 / -1; }
      .file-tools { align-items: flex-start; flex-direction: column; }
      .file-filter { width: 100%; }
      .file-list .file-list { margin-left: 13px; }
    }

    @media (max-width: 360px) {
      .highlight { white-space: normal; }
      .form-actions { flex-wrap: wrap; }
      .form-actions .input-kind { margin-left: auto; }
      .form-actions .primary-button { flex-basis: 100%; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <main id="main-content" class="shell">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-grid">
        <div class="hero-intro">
          <p class="eyebrow">GitHub resource toolkit</p>
          <h1 id="page-title">浏览 GitHub，<br><span class="highlight">从一个链接开始。</span></h1>
          <p class="hero-copy">粘贴公开仓库，集中查看项目概览、Release 与文件树；粘贴 Raw、Archive、Release 或 Gist 链接，则立即生成当前站点的代理地址。</p>
          <ul class="hero-points" aria-label="服务特点">
            <li class="hero-point">无需 GitHub Token</li>
            <li class="hero-point">目录按需加载</li>
            <li class="hero-point">保留源站链接</li>
          </ul>
        </div>
        <div class="command-panel" aria-label="GitHub 链接处理工具">
          <div class="command-head">
            <div>
              <span class="command-kicker">Paste · Detect · Go</span>
              <h2>粘贴 GitHub 链接</h2>
            </div>
            <div class="command-tools">
              <span class="command-note">浏览器本地识别</span>
              <button id="theme-toggle" class="icon-button" type="button" aria-label="切换为深色主题" title="切换主题">◐</button>
            </div>
          </div>
          <div class="command-area">
            <form id="url-form" class="url-form" autocomplete="off" novalidate>
              <label for="url-input" hidden>GitHub 仓库或资源 URL</label>
              <span class="input-prefix" aria-hidden="true">URL</span>
              <input id="url-input" class="url-input" name="github-resource-url" type="url" inputmode="url" autocomplete="off" aria-autocomplete="none" autocapitalize="off" spellcheck="false" placeholder="https://github.com/owner/repo" aria-describedby="input-hint" required>
              <button id="clear-input" class="clear-button" type="button" aria-label="清空输入" title="清空输入" hidden>×</button>
              <div class="form-actions">
                <span id="input-kind" class="input-kind">等待输入</span>
                <button id="submit-button" class="primary-button" type="submit">识别并继续 →</button>
              </div>
            </form>
            <div class="command-meta">
              <p id="input-hint" class="form-hint" aria-live="polite">支持公开仓库，以及常见 GitHub 下载与源码资源。</p>
            </div>
          </div>

          <div class="quick-links" aria-label="示例链接">
            <span class="quick-label">快速试用</span>
            <button class="example-button" type="button" data-example="https://github.com/cloudflare/workers-sdk">仓库示例</button>
            <button class="example-button" type="button" data-example="https://raw.githubusercontent.com/cloudflare/workers-sdk/main/README.md">Raw 示例</button>
            <span class="quick-label">按 <kbd>/</kbd> 聚焦</span>
          </div>

        </div>
      </div>
    </section>

    <section id="welcome" class="feature-strip" aria-label="功能说明">
      <article class="feature-item"><span class="feature-index">01 / EXPLORE</span><strong>仓库信息一屏掌握</strong><p>概览、版本、文件与 README 入口按清晰层级呈现。</p></article>
      <article class="feature-item"><span class="feature-index">02 / PROXY</span><strong>资源链接即贴即用</strong><p>保留原始地址，并生成匹配当前部署前缀的代理 URL。</p></article>
      <article class="feature-item"><span class="feature-index">03 / SAFE</span><strong>默认安全、按需加载</strong><p>只接收受支持的 HTTPS 主机，目录展开后才发起请求。</p></article>
    </section>

    <div id="results" class="results">
      <section id="global-status" class="panel status-panel" aria-live="polite" aria-atomic="true" hidden></section>

      <section id="resource-result" class="panel" aria-labelledby="resource-title" hidden>
        <div class="panel-header">
          <div>
            <span class="section-kicker">Proxy route</span>
            <h2 id="resource-title">代理链接已生成</h2>
            <p class="section-caption">该地址会通过当前 Worker 安全转发。</p>
          </div>
          <span id="resource-kind" class="badge success">资源链接</span>
        </div>
        <div class="proxy-grid">
          <div class="url-card">
            <label class="field-label" for="original-output"><span>原始 URL</span><span>Source</span></label>
            <input id="original-output" class="output-input" type="text" readonly>
          </div>
          <div class="url-card">
            <label class="field-label" for="proxy-output"><span>代理 URL</span><span>Passage</span></label>
            <input id="proxy-output" class="output-input" type="text" readonly>
          </div>
        </div>
        <div class="proxy-actions">
          <div class="link-actions">
            <button id="copy-proxy" class="primary-button" type="button">复制代理链接</button>
            <a id="open-proxy" class="secondary-link" href="#" target="_blank" rel="noopener noreferrer">打开代理 ↗</a>
            <a id="open-original" class="secondary-link" href="#" target="_blank" rel="noopener noreferrer">查看原始链接 ↗</a>
          </div>
          <p id="copy-status" class="form-hint" aria-live="polite"></p>
        </div>
      </section>

      <div id="project-result" hidden>
        <section id="warnings-panel" class="panel warning-panel" aria-labelledby="warnings-title" hidden>
          <span class="section-kicker">Partial response</span>
          <h2 id="warnings-title">部分信息暂不可用</h2>
          <ul id="warnings-list" class="warning-list"></ul>
        </section>

        <section id="overview-panel" class="panel" aria-labelledby="overview-title" hidden>
          <span class="section-kicker">Repository overview</span>
          <div class="repo-top">
            <div>
              <div class="repo-name-row">
                <h2 id="overview-title">项目概览</h2>
                <span id="repo-visibility" class="badge"></span>
                <span id="repo-archived" class="badge warning" hidden>Archived</span>
              </div>
              <p id="repo-description" class="repo-description"></p>
            </div>
            <div class="repo-actions">
              <a id="repo-link" class="button-link" href="#" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
              <a id="download-zip" class="secondary-link" href="#" target="_blank" rel="noopener noreferrer">下载 ZIP ↓</a>
            </div>
          </div>
          <div id="overview-grid" class="overview-grid"></div>
          <div class="clone-box">
            <span class="clone-label">Proxy clone</span>
            <code id="clone-command" class="clone-command"></code>
            <button id="copy-clone" class="secondary-button" type="button">复制命令</button>
          </div>
          <p id="clone-status" class="form-hint" aria-live="polite"></p>
        </section>

        <section id="releases-panel" class="panel" aria-labelledby="releases-title" hidden>
          <div class="panel-header">
            <div>
              <span class="section-kicker">Ship history</span>
              <h2 id="releases-title">Releases</h2>
              <p class="section-caption">附件下载会自动走当前站点的代理通道。</p>
            </div>
            <span id="release-count" class="badge"></span>
          </div>
          <div id="release-list"></div>
        </section>

        <section id="files-panel" class="panel" aria-labelledby="files-title" hidden>
          <div class="panel-header">
            <div>
              <span class="section-kicker">Source tree</span>
              <h2 id="files-title">项目文件</h2>
              <p id="files-caption" class="section-caption">根目录 · 目录按需展开</p>
            </div>
            <div class="file-tools">
              <input id="file-filter" class="file-filter" type="search" placeholder="筛选根目录…" aria-label="筛选根目录文件">
              <span id="branch-badge" class="badge"></span>
            </div>
          </div>
          <div id="file-browser" class="file-browser"></div>
        </section>

        <section id="readme-panel" class="panel" aria-labelledby="readme-title" hidden>
          <div class="panel-header">
            <div>
              <span class="section-kicker">Documentation</span>
              <h2 id="readme-title">README</h2>
              <p class="section-caption">为避免执行远程内容，本页只提供可信查看与下载入口。</p>
            </div>
          </div>
          <div id="readme-content"></div>
        </section>
      </div>
    </div>
  </main>

  <footer>
    <div class="shell footer-inner">
      <span>链接先在浏览器中校验；仓库数据由当前 Worker 请求 GitHub API。</span>
      <span class="footer-code">Passage / no external assets</span>
    </div>
  </footer>

  <script id="app-config" type="application/json">__APP_CONFIG__</script>
  <script>
  (function () {
    "use strict";

    var configNode = document.getElementById("app-config");
    var config = JSON.parse(configNode.textContent || "{}");
    var rawPrefix = typeof config.prefix === "string" ? config.prefix : "/";
    var prefixCore = rawPrefix.replace(/^\/+|\/+$/g, "");
    var prefix = prefixCore ? "/" + prefixCore + "/" : "/";
    var origin = window.location.origin;
    var requestSequence = 0;
    var activeController = null;
    var lastAction = null;
    var nodeSequence = 0;
    var rootContents = [];
    var rootContext = null;

    var form = byId("url-form");
    var input = byId("url-input");
    var submitButton = byId("submit-button");
    var clearButton = byId("clear-input");
    var inputHint = byId("input-hint");
    var inputKind = byId("input-kind");
    var globalStatus = byId("global-status");
    var welcome = byId("welcome");
    var resourceResult = byId("resource-result");
    var projectResult = byId("project-result");
    var copyButton = byId("copy-proxy");
    var fileFilter = byId("file-filter");

    function byId(id) {
      return document.getElementById(id);
    }

    function makeElement(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function setVisible(node, visible) {
      node.hidden = !visible;
    }

    function setInputHint(message, kind) {
      inputHint.textContent = message;
      inputHint.className = "form-hint" + (kind ? " " + kind : "");
    }

    function setInputKind(label, valid) {
      inputKind.textContent = label;
      inputKind.className = "input-kind" + (valid ? " valid" : "");
    }

    function apiUrl(route, parameters) {
      var target = new URL(prefix + route, origin);
      Object.keys(parameters || {}).forEach(function (key) {
        var value = parameters[key];
        if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
      });
      return target.href;
    }

    function safeHttpsUrl(value, allowedHosts) {
      if (typeof value !== "string" || !value) return null;
      try {
        var parsed = new URL(value);
        var host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
        if (allowedHosts && allowedHosts.indexOf(host) === -1) return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    function cleanProjectSegment(segment) {
      var decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch (error) {
        return null;
      }
      if (!decoded || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) return null;
      if (!/^[A-Za-z0-9_.-]+$/.test(decoded)) return null;
      return decoded;
    }

    function classifyInput(value) {
      var parsed = safeHttpsUrl(String(value || "").trim());
      if (!parsed) return { type: "invalid", message: "请输入有效的 GitHub HTTPS 链接。" };
      parsed.hash = "";
      var host = parsed.hostname.toLowerCase();
      var rawSegments = parsed.pathname.split("/").filter(Boolean);

      if ((host === "github.com" || host === "www.github.com") && rawSegments.length === 2) {
        var owner = cleanProjectSegment(rawSegments[0]);
        var repo = cleanProjectSegment(rawSegments[1]);
        if (repo && /\.git$/i.test(repo)) repo = repo.slice(0, -4);
        if (!owner || !repo) return { type: "invalid", message: "仓库链接中的 owner 或仓库名无效。" };
        var canonical = new URL("https://github.com/");
        canonical.pathname = "/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
        return { type: "project", url: canonical.href, owner: owner, repo: repo };
      }

      if (isSupportedResource(parsed, rawSegments)) {
        return { type: "resource", url: parsed.href, kind: resourceKind(parsed, rawSegments) };
      }
      return { type: "invalid", message: "该链接不是仓库首页，也不是受支持的 GitHub 资源。" };
    }

    function isSupportedResource(parsed, segments) {
      var host = parsed.hostname.toLowerCase();
      var route = segments.length > 2 ? String(segments[2]).toLowerCase() : "";
      if (host === "github.com" || host === "www.github.com") {
        if (segments.length < 3) return false;
        if ((route === "blob" || route === "raw" || route === "resolve") && segments.length >= 5) return true;
        if (route === "archive" && segments.length >= 4) return true;
        if ((route === "tarball" || route === "zipball") && segments.length >= 4) return true;
        if (route === "releases" && segments.length >= 5 && (String(segments[3]).toLowerCase() === "download" || String(segments[3]).toLowerCase() === "latest")) return true;
        return false;
      }
      if (host === "raw.githubusercontent.com") return segments.length >= 4;
      if (host === "gist.github.com" || host === "gist.githubusercontent.com") return segments.length >= 1;
      if (host === "codeload.github.com") return segments.length >= 4;
      if (host === "cdn.jsdelivr.net") return segments.length >= 4 && String(segments[0]).toLowerCase() === "gh" && String(segments[2]).indexOf("@") > 0;
      if (
        host === "objects.githubusercontent.com" ||
        host === "github-releases.githubusercontent.com" ||
        host === "release-assets.githubusercontent.com" ||
        host === "github-cloud.s3.amazonaws.com" ||
        /^github-production-release-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(host)
      ) return segments.length >= 1;
      return false;
    }

    function resourceKind(parsed, segments) {
      var host = parsed.hostname.toLowerCase();
      var route = segments.length > 2 ? String(segments[2]).toLowerCase() : "";
      if (host === "raw.githubusercontent.com" || host === "cdn.jsdelivr.net" || route === "blob" || route === "raw" || route === "resolve") return "源码文件";
      if (host.indexOf("gist.") === 0) return "Gist";
      if (host === "codeload.github.com" || route === "archive" || route === "tarball" || route === "zipball") return "源码归档";
      if (route === "releases" || host.indexOf("release") !== -1 || host === "objects.githubusercontent.com" || /\.s3\.amazonaws\.com$/.test(host)) return "Release 资源";
      return "GitHub 资源";
    }

    function proxyUrl(externalUrl) {
      var classification = classifyInput(externalUrl);
      if (classification.type !== "resource") return null;
      return origin + prefix + classification.url;
    }

    function setExternalLink(link, value, hosts) {
      var safe = safeHttpsUrl(value, hosts);
      if (!safe) {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.hidden = true;
        return false;
      }
      link.href = safe.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.removeAttribute("aria-disabled");
      link.hidden = false;
      return true;
    }

    function externalAnchor(label, value, hosts, className) {
      var link = makeElement("a", className || "", label);
      if (!setExternalLink(link, value, hosts)) return null;
      return link;
    }

    function proxiedAnchor(label, value, className) {
      var href = proxyUrl(value);
      if (!href) return null;
      var link = makeElement("a", className || "", label);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }

    function updateAddress(value, replace) {
      try {
        var target = new URL(window.location.href);
        target.searchParams.delete("q");
        if (value) target.searchParams.set("url", value);
        else target.searchParams.delete("url");
        window.history[replace ? "replaceState" : "pushState"]({}, "", target.href);
      } catch (error) {
        return;
      }
    }

    function resetResults(showWelcome) {
      setVisible(welcome, showWelcome === true);
      setVisible(resourceResult, false);
      setVisible(projectResult, false);
      hideStatus();
      if (activeController) activeController.abort();
      activeController = null;
      requestSequence += 1;
    }

    function hideStatus() {
      globalStatus.replaceChildren();
      setVisible(globalStatus, false);
    }

    function showLoadingStatus(message) {
      globalStatus.replaceChildren();
      var orbit = makeElement("div", "status-orbit");
      orbit.setAttribute("aria-hidden", "true");
      var title = makeElement("p", "status-title", message);
      var copy = makeElement("p", "status-copy", "正在并行获取仓库概览、Release、根目录与 README 信息。");
      var skeletons = makeElement("div", "skeleton-grid");
      skeletons.setAttribute("aria-hidden", "true");
      for (var index = 0; index < 6; index += 1) skeletons.appendChild(makeElement("div", "skeleton"));
      globalStatus.append(orbit, title, copy, skeletons);
      setVisible(globalStatus, true);
    }

    function showErrorStatus(titleText, message, retry) {
      globalStatus.replaceChildren();
      var title = makeElement("p", "status-title", titleText);
      var copy = makeElement("p", "status-copy", message);
      globalStatus.append(title, copy);
      if (retry) {
        var actions = makeElement("div", "status-actions");
        var retryButton = makeElement("button", "secondary-button", "重新尝试");
        retryButton.type = "button";
        retryButton.addEventListener("click", retry);
        actions.appendChild(retryButton);
        globalStatus.appendChild(actions);
      }
      setVisible(globalStatus, true);
    }

    function AppError(status, message, kind) {
      this.name = "AppError";
      this.status = status;
      this.message = message;
      this.kind = kind || "server";
    }
    AppError.prototype = Object.create(Error.prototype);
    AppError.prototype.constructor = AppError;

    async function fetchJson(url, options) {
      var response;
      try {
        response = await fetch(url, Object.assign({
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        }, options || {}));
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        throw new AppError(0, "无法连接到服务，请检查网络后重试。", "network");
      }

      var body = null;
      try {
        body = await response.json();
      } catch (error) {
        if (response.ok) throw new AppError(response.status, "服务返回了无法解析的数据。", "invalid-response");
      }

      if (!response.ok) {
        var serverMessage = body && typeof body === "object" ? (body.message || body.error) : "";
        var message = typeof serverMessage === "string" ? serverMessage : "";
        if (response.status === 429 || (response.status === 403 && /rate.?limit/i.test(message))) {
          var retryAfter = response.headers.get("retry-after");
          var reset = response.headers.get("x-ratelimit-reset");
          var extra = retryAfter ? " 请在 " + retryAfter + " 秒后重试。" : "";
          if (!extra && reset && /^\d+$/.test(reset)) extra = " 请在 " + formatDate(Number(reset) * 1000) + " 后重试。";
          throw new AppError(response.status, "GitHub API 请求已达到限额。" + extra, "rate-limit");
        }
        if (response.status === 404) throw new AppError(404, "找不到该仓库，请确认它是可公开访问的项目。", "not-found");
        if (response.status === 403) throw new AppError(403, message || "GitHub 拒绝了请求；仓库可能是私有的或当前请求受限。", "forbidden");
        throw new AppError(response.status, message || "服务请求失败，请稍后重试。", "server");
      }
      return body;
    }

    function describeError(error) {
      if (error instanceof AppError) {
        if (error.kind === "rate-limit") return { title: "请求达到限额", message: error.message };
        if (error.kind === "not-found") return { title: "仓库不存在或不可访问", message: error.message };
        if (error.kind === "network") return { title: "网络连接失败", message: error.message };
        return { title: "暂时无法完成请求", message: error.message };
      }
      return { title: "出现未知错误", message: "页面未能完成请求，请重新尝试。" };
    }

    function handleClassification(classification, options) {
      input.removeAttribute("aria-invalid");
      if (classification.type === "project") {
        setInputHint("已识别为公开仓库，正在打开项目视图。", "success");
        setInputKind("Repository", true);
        if (!options || options.updateHistory !== false) updateAddress(classification.url, false);
        loadRepository(classification, options);
      } else if (classification.type === "resource") {
        setInputHint("已识别为 " + classification.kind + "，正在生成代理地址。", "success");
        setInputKind(classification.kind, true);
        if (!options || options.updateHistory !== false) updateAddress(classification.url, false);
        renderResource(classification.url, classification.kind, options);
      } else {
        input.setAttribute("aria-invalid", "true");
        setInputHint(classification.message, "error");
        setInputKind("链接无效", false);
        input.focus();
      }
    }

    function renderResource(resourceUrl, kind, options) {
      resetResults(false);
      var proxied = proxyUrl(resourceUrl);
      if (!proxied) {
        setInputHint("该资源无法安全转换为代理地址。", "error");
        return;
      }
      byId("original-output").value = resourceUrl;
      byId("proxy-output").value = proxied;
      byId("open-proxy").href = proxied;
      setExternalLink(byId("open-original"), resourceUrl);
      byId("resource-kind").textContent = kind || "GitHub 资源";
      byId("copy-status").textContent = "";
      setVisible(resourceResult, true);
      document.title = "代理链接 — Passage";
      lastAction = function () { renderResource(resourceUrl, kind); };
      if (!options || options.scroll !== false) byId("results").scrollIntoView({ block: "start", behavior: "smooth" });
    }

    async function loadRepository(classification, options) {
      resetResults(false);
      setVisible(projectResult, true);
      ["warnings-panel", "overview-panel", "releases-panel", "files-panel", "readme-panel"].forEach(function (id) {
        setVisible(byId(id), false);
      });
      showLoadingStatus("正在打开 " + classification.owner + "/" + classification.repo);
      submitButton.disabled = true;
      submitButton.textContent = "加载中…";
      var sequence = requestSequence;
      var controller = new AbortController();
      activeController = controller;
      lastAction = function () { loadRepository(classification); };

      try {
        var data = await fetchJson(apiUrl("api/repo", { url: classification.url }), { signal: controller.signal });
        if (sequence !== requestSequence) return;
        if (!data || typeof data !== "object" || !data.repository || typeof data.repository !== "object") {
          throw new AppError(200, "项目接口缺少 repository 数据。", "invalid-response");
        }
        renderRepository(data, classification, options);
        hideStatus();
      } catch (error) {
        if (error && error.name === "AbortError") return;
        if (sequence !== requestSequence) return;
        var described = describeError(error);
        showErrorStatus(described.title, described.message, lastAction);
      } finally {
        if (sequence === requestSequence) {
          submitButton.disabled = false;
          submitButton.textContent = "识别并继续 →";
          activeController = null;
        }
      }
    }

    function renderRepository(data, classification, options) {
      var repository = data.repository;
      var owner = repository.owner && typeof repository.owner.login === "string" ? repository.owner.login : classification.owner;
      var repo = typeof repository.name === "string" && repository.name ? repository.name : classification.repo;
      var branch = typeof repository.default_branch === "string" ? repository.default_branch : "";
      var context = { owner: owner, repo: repo, ref: branch };
      renderWarnings(data.warnings);
      renderOverview(repository, owner, repo);
      renderReleases(data.releases);
      renderRootContents(data.contents, context);
      renderReadme(data.readme, context);
      ["overview-panel", "releases-panel", "files-panel", "readme-panel"].forEach(function (id) {
        setVisible(byId(id), true);
      });
      document.title = (repository.full_name || owner + "/" + repo) + " — Passage";
      if (!options || options.scroll !== false) byId("results").scrollIntoView({ block: "start", behavior: "smooth" });
    }

    function warningText(warning) {
      if (typeof warning === "string") return warning;
      if (!warning || typeof warning !== "object") return "部分数据加载失败。";
      var scope = warning.scope || warning.resource || warning.source || "";
      var scopeNames = { releases: "Releases", contents: "文件目录", readme: "README" };
      var warningMessages = {
        github_rate_limited: "GitHub API 请求达到限额，请稍后重试或为 Worker 配置 GITHUB_TOKEN",
        github_api_unavailable: "GitHub API 暂时不可用",
        github_api_forbidden: "GitHub 拒绝了该项请求",
        github_api_unauthorized: "Worker 的 GitHub Token 无效",
        repository_not_found: "仓库不可访问",
        invalid_github_response: "GitHub 返回的数据格式无效"
      };
      var message = warning.message || warning.error || warningMessages[warning.code] || "加载失败";
      return (scope ? (scopeNames[String(scope)] || String(scope)) + "：" : "") + String(message);
    }

    function renderWarnings(warnings) {
      var panel = byId("warnings-panel");
      var list = byId("warnings-list");
      list.replaceChildren();
      if (!Array.isArray(warnings) || warnings.length === 0) {
        setVisible(panel, false);
        return;
      }
      warnings.forEach(function (warning) {
        list.appendChild(makeElement("li", "", warningText(warning)));
      });
      setVisible(panel, true);
    }

    function renderOverview(repository, owner, repo) {
      var fullName = typeof repository.full_name === "string" ? repository.full_name : owner + "/" + repo;
      byId("overview-title").textContent = fullName;
      byId("repo-description").textContent = typeof repository.description === "string" && repository.description ? repository.description : "这个项目还没有填写简介。";
      var visibility = byId("repo-visibility");
      visibility.textContent = repository.private ? "Private" : "Public";
      visibility.className = "badge" + (repository.private ? " warning" : " success");
      setVisible(byId("repo-archived"), repository.archived === true);
      var repoHref = safeHttpsUrl(repository.html_url, ["github.com"]);
      var fallbackHref = "https://github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
      setExternalLink(byId("repo-link"), repoHref ? repoHref.href : fallbackHref, ["github.com"]);

      var branch = repository.default_branch || "HEAD";
      var branchPath = String(branch).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      var archiveUrl = "https://github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/archive/refs/heads/" + branchPath + ".zip";
      var archiveProxy = proxyUrl(archiveUrl);
      if (archiveProxy) {
        byId("download-zip").href = archiveProxy;
        byId("download-zip").hidden = false;
      } else {
        byId("download-zip").hidden = true;
      }

      var metrics = [
        ["Stars", formatNumber(repository.stargazers_count)],
        ["Forks", formatNumber(repository.forks_count)],
        ["Open issues", formatNumber(repository.open_issues_count)],
        ["Language", repository.language || "未标注"],
        ["Default branch", branch],
        ["Updated", formatDate(repository.updated_at, true)]
      ];
      var grid = byId("overview-grid");
      grid.replaceChildren();
      metrics.forEach(function (metric) {
        var card = makeElement("div", "metric");
        card.append(makeElement("span", "metric-label", metric[0]), makeElement("span", "metric-value", metric[1]));
        grid.appendChild(card);
      });

      var repositoryUrl = "https://github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + ".git";
      var cloneCommand = "git clone " + origin + prefix + repositoryUrl;
      byId("clone-command").textContent = cloneCommand;
      byId("clone-status").textContent = "";
    }

    function formatNumber(value) {
      var numeric = Number(value);
      if (!Number.isFinite(numeric)) return "—";
      try { return new Intl.NumberFormat("zh-CN").format(numeric); }
      catch (error) { return String(numeric); }
    }

    function formatDate(value, dateOnly) {
      if (value === null || value === undefined || value === "") return "—";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      try {
        return new Intl.DateTimeFormat("zh-CN", dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
      } catch (error) {
        return date.toLocaleString();
      }
    }

    function formatBytes(value) {
      var bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
      if (bytes < 1024) return formatNumber(bytes) + " B";
      var units = ["KB", "MB", "GB", "TB"];
      var amount = bytes;
      var unit = -1;
      do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
      return amount.toFixed(amount >= 10 ? 1 : 2).replace(/\.0+$/, "") + " " + units[unit];
    }

    function renderReleases(releases) {
      var list = byId("release-list");
      list.replaceChildren();
      var safeReleases = Array.isArray(releases) ? releases.filter(function (release) {
        return release && typeof release === "object";
      }) : [];
      byId("release-count").textContent = formatNumber(safeReleases.length) + " 个版本";
      if (safeReleases.length === 0) {
        list.appendChild(makeElement("div", "empty-state", "该项目暂未发布 GitHub Release。"));
        return;
      }
      var collapseOlderReleases = safeReleases.length > 4;
      var container = makeElement("div", "release-list");
      safeReleases.forEach(function (release, releaseIndex) {
        var assets = Array.isArray(release.assets) ? release.assets : [];
        var card = makeElement("details", "release-card");
        if (!collapseOlderReleases || releaseIndex === 0) card.setAttribute("open", "");
        var summary = makeElement("summary", "release-summary");
        var top = makeElement("div", "release-top");
        var headingWrap = makeElement("div");
        var titleRow = makeElement("div", "release-title");
        var titleText = release.name || release.tag_name || "未命名版本";
        var title = makeElement("h3", "", titleText);
        titleRow.appendChild(title);
        if (release.draft) titleRow.appendChild(makeElement("span", "badge danger", "Draft"));
        if (release.prerelease) titleRow.appendChild(makeElement("span", "badge warning", "Prerelease"));
        if (!release.draft && !release.prerelease) titleRow.appendChild(makeElement("span", "badge success", "Release"));
        headingWrap.appendChild(titleRow);
        headingWrap.appendChild(makeElement("p", "release-meta", "TAG " + (release.tag_name || "—") + " · " + formatDate(release.published_at || release.created_at)));
        top.appendChild(headingWrap);
        var summarySide = makeElement("span", "release-summary-side");
        summarySide.appendChild(makeElement("span", "badge", assets.length ? formatNumber(assets.length) + " 个附件" : "无附件"));
        var chevron = makeElement("span", "release-chevron");
        chevron.setAttribute("aria-hidden", "true");
        summarySide.appendChild(chevron);
        top.appendChild(summarySide);
        summary.appendChild(top);
        card.appendChild(summary);

        var body = makeElement("div", "release-body");
        var releaseLink = externalAnchor("在 GitHub 查看 ↗", release.html_url, ["github.com"], "secondary-link");
        if (releaseLink) {
          var bodyActions = makeElement("div", "release-body-actions");
          bodyActions.appendChild(releaseLink);
          body.appendChild(bodyActions);
        }
        if (assets.length) {
          var assetList = makeElement("ul", "asset-list");
          assets.forEach(function (asset) {
            if (!asset || typeof asset !== "object") return;
            var row = makeElement("li", "asset-row");
            row.appendChild(makeElement("span", "asset-name", asset.name || "未命名资源"));
            var detail = formatBytes(asset.size);
            if (Number(asset.download_count) > 0) detail += " · " + formatNumber(asset.download_count) + " 次下载";
            row.appendChild(makeElement("span", "asset-size", detail));
            var download = proxiedAnchor("代理下载 ↓", asset.browser_download_url, "asset-link");
            if (download) row.appendChild(download);
            else row.appendChild(makeElement("span", "asset-size", "链接不可用"));
            assetList.appendChild(row);
          });
          if (assetList.childElementCount) body.appendChild(assetList);
        } else {
          body.appendChild(makeElement("p", "release-empty", "该版本没有附件资源。"));
        }
        card.appendChild(body);
        container.appendChild(card);
      });
      if (!container.childElementCount) list.appendChild(makeElement("div", "empty-state", "Release 数据为空。"));
      else list.appendChild(container);
    }

    function normalizeContentsPayload(payload) {
      if (Array.isArray(payload)) return payload;
      if (payload && typeof payload === "object" && Array.isArray(payload.contents)) return payload.contents;
      throw new AppError(200, "目录接口返回了无法识别的数据。", "invalid-response");
    }

    function sortedContents(items) {
      return items.filter(function (item) { return item && typeof item === "object"; }).slice().sort(function (left, right) {
        var leftDirectory = left.type === "dir" ? 0 : 1;
        var rightDirectory = right.type === "dir" ? 0 : 1;
        if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory;
        return String(left.name || "").localeCompare(String(right.name || ""), undefined, { sensitivity: "base", numeric: true });
      });
    }

    function renderRootContents(payload, context) {
      var items;
      try {
        items = normalizeContentsPayload(payload);
      } catch (error) {
        rootContents = [];
        rootContext = context;
        renderFilteredRoot();
        return;
      }
      rootContents = items;
      rootContext = context;
      fileFilter.value = "";
      byId("branch-badge").textContent = context.ref ? "branch / " + context.ref : "默认分支";
      renderFilteredRoot();
    }

    function renderFilteredRoot() {
      var browser = byId("file-browser");
      browser.replaceChildren();
      if (!rootContext) {
        browser.appendChild(makeElement("div", "empty-state file-error", "目录上下文不可用。"));
        return;
      }
      var query = fileFilter.value.trim().toLocaleLowerCase();
      var items = rootContents.filter(function (item) {
        return !query || String(item && item.name || "").toLocaleLowerCase().indexOf(query) !== -1;
      });
      byId("files-caption").textContent = query ? "根目录 · 找到 " + formatNumber(items.length) + " 项" : "根目录 · " + formatNumber(rootContents.length) + " 项 · 目录按需展开";
      if (!items.length) {
        browser.appendChild(makeElement("div", "empty-state", query ? "没有匹配的根目录项目。" : "根目录为空，或目录数据暂不可用。"));
        return;
      }
      browser.appendChild(createContentsList(items, rootContext, 1, true));
    }

    function createContentsList(items, context, level, isTree) {
      var list = makeElement("ul", "file-list");
      list.setAttribute("role", isTree ? "tree" : "group");
      sortedContents(items).forEach(function (item) {
        list.appendChild(createContentNode(item, context, level));
      });
      return list;
    }

    function fileKind(name) {
      var value = String(name || "");
      var dot = value.lastIndexOf(".");
      if (dot > 0 && dot < value.length - 1) return value.slice(dot + 1, dot + 6);
      return "file";
    }

    function createContentNode(item, context, level) {
      var node = makeElement("li", "file-node");
      node.setAttribute("role", "treeitem");
      node.setAttribute("aria-level", String(level));
      var row = makeElement("div", "file-row");
      var main = makeElement("div", "file-main");
      var actions = makeElement("div", "file-actions");
      var name = typeof item.name === "string" && item.name ? item.name : "(未命名)";

      if (item.type === "dir") {
        var controlId = "directory-" + (++nodeSequence);
        var toggle = makeElement("button", "directory-toggle");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", controlId);
        toggle.setAttribute("aria-label", "展开目录 " + name);
        var disclosure = makeElement("span", "disclosure", "›");
        disclosure.setAttribute("aria-hidden", "true");
        var directoryKind = makeElement("span", "file-kind directory", "dir");
        directoryKind.setAttribute("aria-hidden", "true");
        toggle.append(disclosure, directoryKind, makeElement("span", "file-name", name));
        main.appendChild(toggle);
        var group = makeElement("ul", "file-list");
        group.id = controlId;
        group.setAttribute("role", "group");
        group.hidden = true;
        var state = { loaded: false, loading: false };

        async function expand() {
          toggle.setAttribute("aria-expanded", "true");
          toggle.setAttribute("aria-label", "收起目录 " + name);
          group.hidden = false;
          if (!state.loaded && !state.loading) await loadDirectory(item, context, level + 1, group, state, toggle);
        }
        function collapse() {
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", "展开目录 " + name);
          group.hidden = true;
        }
        toggle.addEventListener("click", function () {
          if (toggle.getAttribute("aria-expanded") === "true") collapse();
          else expand();
        });
        toggle.addEventListener("keydown", function (event) {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            if (toggle.getAttribute("aria-expanded") !== "true") expand();
            else {
              var childToggle = group.querySelector(".directory-toggle, a");
              if (childToggle) childToggle.focus();
            }
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (toggle.getAttribute("aria-expanded") === "true") collapse();
          }
        });
        node.append(row, group);
      } else {
        var kind = makeElement("span", "file-kind", fileKind(name));
        kind.setAttribute("aria-hidden", "true");
        main.append(kind, makeElement("span", "file-name", name));
        node.appendChild(row);
      }

      var githubLink = externalAnchor("GitHub", item.html_url, ["github.com"]);
      if (githubLink) actions.appendChild(githubLink);
      if (item.type !== "dir" && item.download_url) {
        var rawLink = externalAnchor("Raw", item.download_url, ["raw.githubusercontent.com", "gist.githubusercontent.com"]);
        var proxyLink = proxiedAnchor("代理 ↓", item.download_url);
        if (rawLink) actions.appendChild(rawLink);
        if (proxyLink) actions.appendChild(proxyLink);
      }
      row.append(main, actions);
      return node;
    }

    async function loadDirectory(item, context, level, group, state, toggle) {
      state.loading = true;
      group.replaceChildren();
      var loading = makeElement("li", "file-placeholder", "正在加载目录…");
      loading.setAttribute("role", "status");
      group.appendChild(loading);
      try {
        var payload = await fetchJson(apiUrl("api/contents", {
          owner: context.owner,
          repo: context.repo,
          path: item.path || "",
          ref: context.ref
        }));
        var contents = normalizeContentsPayload(payload);
        group.replaceChildren();
        if (!contents.length) {
          var empty = makeElement("li", "file-placeholder", "该目录为空。");
          empty.setAttribute("role", "treeitem");
          group.appendChild(empty);
        } else {
          var nested = createContentsList(contents, context, level, false);
          while (nested.firstChild) group.appendChild(nested.firstChild);
        }
        state.loaded = true;
      } catch (error) {
        var described = describeError(error);
        group.replaceChildren();
        var failure = makeElement("li", "file-placeholder file-error");
        failure.setAttribute("role", "treeitem");
        failure.appendChild(document.createTextNode(described.message));
        var retry = makeElement("button", "text-button", "重试");
        retry.type = "button";
        retry.addEventListener("click", function () {
          state.loaded = false;
          state.loading = false;
          toggle.setAttribute("aria-expanded", "true");
          loadDirectory(item, context, level, group, state, toggle);
        });
        failure.appendChild(retry);
        group.appendChild(failure);
      } finally {
        state.loading = false;
      }
    }

    function renderReadme(readme, context) {
      var container = byId("readme-content");
      container.replaceChildren();
      if (!readme || typeof readme !== "object") {
        container.appendChild(makeElement("div", "empty-state", "该项目没有可用的 README，或 README 信息暂时加载失败。"));
        return;
      }
      var card = makeElement("div", "readme-card");
      var copy = makeElement("div");
      copy.appendChild(makeElement("h3", "", readme.name || "README"));
      copy.appendChild(makeElement("p", "", "为保障页面安全，这里不会执行或渲染仓库中的 Markdown。你可以通过右侧入口查看原文或使用代理下载。"));
      var actions = makeElement("div", "link-actions");
      var fallbackGithub = null;
      if (readme.path && context.owner && context.repo && context.ref) {
        fallbackGithub = "https://github.com/" + encodeURIComponent(context.owner) + "/" + encodeURIComponent(context.repo) + "/blob/" + encodeURIComponent(context.ref) + "/" + encodePath(readme.path);
      }
      var githubLink = externalAnchor("GitHub 查看 ↗", readme.html_url || fallbackGithub, ["github.com"], "button-link");
      var rawLink = externalAnchor("Raw ↗", readme.download_url, ["raw.githubusercontent.com", "gist.githubusercontent.com"], "secondary-link");
      var proxyLink = proxiedAnchor("代理下载 ↓", readme.download_url, "secondary-link");
      if (githubLink) actions.appendChild(githubLink);
      if (rawLink) actions.appendChild(rawLink);
      if (proxyLink) actions.appendChild(proxyLink);
      if (!actions.childElementCount) actions.appendChild(makeElement("span", "section-caption", "README 链接不可用。"));
      card.append(copy, actions);
      container.appendChild(card);
    }

    function encodePath(path) {
      return String(path).split("/").filter(Boolean).map(function (segment) {
        return encodeURIComponent(segment);
      }).join("/");
    }

    async function copyText(value, statusNode, successMessage) {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(value);
        statusNode.textContent = successMessage;
        statusNode.className = "form-hint success";
      } catch (error) {
        statusNode.textContent = "无法自动复制，请手动选择并复制。";
        statusNode.className = "form-hint";
      }
    }

    function updateInputPreview() {
      input.removeAttribute("aria-invalid");
      var value = input.value.trim();
      setVisible(clearButton, value.length > 0);
      if (!value) {
        setInputHint("支持公开仓库，以及常见 GitHub 下载与源码资源。");
        setInputKind("等待输入", false);
        submitButton.textContent = "识别并继续 →";
        return;
      }
      var classification = classifyInput(value);
      if (classification.type === "project") {
        setInputHint("仓库链接 · 提交后打开项目视图。", "success");
        setInputKind("Repository", true);
        submitButton.textContent = "浏览仓库 →";
      } else if (classification.type === "resource") {
        setInputHint(classification.kind + " · 提交后生成代理地址。", "success");
        setInputKind(classification.kind, true);
        submitButton.textContent = "生成代理 →";
      } else {
        setInputHint("继续输入完整的 GitHub HTTPS 链接。");
        setInputKind("待识别", false);
        submitButton.textContent = "识别并继续 →";
      }
    }

    function loadFromAddress(options) {
      var parameters = new URL(window.location.href).searchParams;
      var value = parameters.get("url") || parameters.get("q") || "";
      input.value = value;
      updateInputPreview();
      if (!value) {
        resetResults(true);
        document.title = "Passage — GitHub 资源中转与仓库浏览";
        return;
      }
      handleClassification(classifyInput(value), { updateHistory: false, scroll: options && options.scroll === true });
    }

    function currentDarkMode() {
      var theme = document.documentElement.getAttribute("data-theme");
      if (theme === "dark") return true;
      if (theme === "light") return false;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    function updateThemeButton() {
      var dark = currentDarkMode();
      var button = byId("theme-toggle");
      button.textContent = dark ? "☀" : "◐";
      button.setAttribute("aria-label", dark ? "切换为浅色主题" : "切换为深色主题");
      button.title = dark ? "切换为浅色主题" : "切换为深色主题";
    }

    function initializeTheme() {
      var stored = "auto";
      try { stored = window.localStorage.getItem("passage-theme") || "auto"; } catch (error) { stored = "auto"; }
      if (stored !== "light" && stored !== "dark") stored = "auto";
      document.documentElement.setAttribute("data-theme", stored);
      updateThemeButton();
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      handleClassification(classifyInput(input.value));
    });

    input.addEventListener("input", updateInputPreview);

    clearButton.addEventListener("click", function () {
      input.value = "";
      updateInputPreview();
      updateAddress("", false);
      resetResults(true);
      document.title = "Passage — GitHub 资源中转与仓库浏览";
      input.focus();
    });

    document.querySelectorAll("[data-example]").forEach(function (button) {
      button.addEventListener("click", function () {
        input.value = button.getAttribute("data-example") || "";
        updateInputPreview();
        handleClassification(classifyInput(input.value));
      });
    });

    copyButton.addEventListener("click", function () {
      copyText(byId("proxy-output").value, byId("copy-status"), "代理链接已复制。");
    });

    byId("copy-clone").addEventListener("click", function () {
      copyText(byId("clone-command").textContent, byId("clone-status"), "Git clone 命令已复制。");
    });

    fileFilter.addEventListener("input", renderFilteredRoot);

    byId("theme-toggle").addEventListener("click", function () {
      var next = currentDarkMode() ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { window.localStorage.setItem("passage-theme", next); } catch (error) { }
      updateThemeButton();
    });

    if (window.matchMedia) {
      var media = window.matchMedia("(prefers-color-scheme: dark)");
      if (typeof media.addEventListener === "function") media.addEventListener("change", updateThemeButton);
    }

    document.addEventListener("keydown", function (event) {
      var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
      if (event.key === "/" && tag !== "input" && tag !== "textarea") {
        event.preventDefault();
        input.focus();
      }
      if (event.key === "Escape" && document.activeElement === input && input.value) clearButton.click();
    });

    window.addEventListener("popstate", function () {
      loadFromAddress({ scroll: false });
    });

    initializeTheme();
    loadFromAddress({ scroll: false });
  }());
  </script>
</body>
</html>`.replace("__APP_CONFIG__", clientConfig);
}

function rootRouteResponse(request, env, config) {
  var url = new URL(request.url);
  var q = url.searchParams.get("q");
  if (q !== null) {
    var repository = parseRepositoryUrl(q);
    if (repository) {
      var project = getOrigin(request) + config.PREFIX + "?url=" + encodeURIComponent(repository.canonical);
      return redirectResponse(project, 302);
    }
    var resource = parseResourceTarget(q);
    if (!resource || resource.kind === "repository") return errorResponse("invalid_target", 400, request);
    return redirectResponse(buildProxyUrl(request, resource.url.toString(), config), 302);
  }
  return responseWithHeaders(requestMethod(request) === "HEAD" ? null : generateHomePage(request, config), 200, new Headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" }));
}

function routeIs(pathname, prefix, route) {
  return pathname === prefix + route || pathname === prefix + route + "/";
}

async function handleRequest(request, env, options) {
  var method = requestMethod(request);
  if (method === "OPTIONS") return optionsResponse();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return errorResponse("method_not_allowed", 405, request);
  try {
    var requestUrl = new URL(request.url);
    var configSource = env && env.CONFIG ? env.CONFIG : env;
    var config = getRuntimeConfig(configSource);
    var prefixWithoutSlash = config.PREFIX.length > 1 ? config.PREFIX.slice(0, -1) : config.PREFIX;
    if (requestUrl.pathname === prefixWithoutSlash && config.PREFIX !== "/") {
      return redirectResponse(getOrigin(request) + config.PREFIX + requestUrl.search, 308);
    }
    if (requestUrl.pathname === config.PREFIX) {
      if (method === "POST") return errorResponse("method_not_allowed", 405, request);
      return rootRouteResponse(request, env, config);
    }
    if (routeIs(requestUrl.pathname, config.PREFIX, "api/repo")) {
      if (method === "POST") return errorResponse("method_not_allowed", 405, request);
      return handleRepoApi(request, env, config);
    }
    if (routeIs(requestUrl.pathname, config.PREFIX, "api/contents")) {
      if (method === "POST") return errorResponse("method_not_allowed", 405, request);
      return handleContentsApi(request, env, config);
    }
    if (requestUrl.pathname.indexOf(config.PREFIX + "api/") === 0) return errorResponse("bad_request", 400, request);

    var target = extractProxyTarget(requestUrl, config.PREFIX);
    if (!target) return errorResponse("invalid_target", 400, request);
    var targetInfo = parseResourceTarget(target);
    if (!targetInfo) return errorResponse("invalid_target", 400, request);
    if (targetInfo.kind === "repository") return errorResponse("repository_url_requires_api", 400, request);
    if (method === "POST") {
      if (targetInfo.kind !== "git" || (targetInfo.gitOperation !== "git-upload-pack" && targetInfo.gitOperation !== "git-receive-pack")) {
        return errorResponse("method_not_allowed", 405, request);
      }
    } else if (targetInfo.kind === "git" && targetInfo.gitOperation && targetInfo.gitOperation !== "info/refs") {
      return errorResponse("method_not_allowed", 405, request);
    }
    if (config.jsDelivr && (targetInfo.kind === "blob" || targetInfo.kind === "raw")) {
      var jsDelivrUrl = buildJsDelivrUrl(targetInfo);
      if (jsDelivrUrl) return redirectResponse(jsDelivrUrl, 302);
    }
    return fetchProxyResource(request, env, config, targetInfo);
  } catch (_) {
    return errorResponse("internal_error", 500, request);
  }
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", function (event) {
    event.respondWith(handleRequest(event.request));
  });
}

// Exports are ignored by Cloudflare and make the pure routing helpers easy to
// exercise with Node's built-in test runner.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    handleRequest: handleRequest,
    generateHomePage: generateHomePage,
    normalizePrefix: normalizePrefix,
    getRuntimeConfig: getRuntimeConfig,
    parseRepositoryUrl: parseRepositoryUrl,
    parseResourceTarget: parseResourceTarget,
    buildJsDelivrUrl: buildJsDelivrUrl,
    buildProxyUrl: buildProxyUrl,
    buildGithubContentsPath: buildGithubContentsPath,
    parseContentsQuery: parseContentsQuery,
    copyHeadersWithoutSensitive: copyHeadersWithoutSensitive,
    fetchProxyResource: fetchProxyResource
  };
}
