/* Zero-dependency tests for the classic Worker entry point. */
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  handleRequest,
  generateHomePage,
  parseRepositoryUrl,
  parseResourceTarget,
  buildGithubContentsPath
} = require("./worker.js");

function request(path, options) {
  return new Request("https://proxy.test" + path, options || {});
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json" }, headers || {})
  });
}

async function body(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write("ok - " + name + "\n");
  } catch (error) {
    process.stderr.write("not ok - " + name + "\n" + error.stack + "\n");
    process.exitCode = 1;
  }
}

(async () => {
  await test("homepage and prefix config", async () => {
    const response = await handleRequest(request("/gh/"), { CONFIG: { PREFIX: "/gh/" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Passage — GitHub 资源中转与仓库浏览/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /id="file-filter"/);
    assert.equal(/[�]/.test(html), false);
    assert.match(html, /\{"prefix":"\/gh\/"\}/);
    assert.equal(html.includes("__APP_CONFIG__"), false);
    const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi), (match) => match[1]);
    assert.equal(scripts.length, 2);
    JSON.parse(scripts[0]);
    new vm.Script(scripts[1]);
    assert.equal(/\.innerHTML\s*=|\beval\s*\(/.test(scripts[1]), false);
  });

  await test("q redirect works regardless of query parameter order", async () => {
    const target = "https://github.com/octo/repo/archive/refs/heads/main.zip";
    const response = await handleRequest(request("/gh/?other=1&q=" + encodeURIComponent(target)), { CONFIG: { PREFIX: "/gh/" } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://proxy.test/gh/" + target);
  });

  await test("repository URL parser is strict and strips .git", async () => {
    const parsed = parseRepositoryUrl("https://github.com/octo/repo.git/");
    assert.equal(parsed.owner, "octo");
    assert.equal(parsed.repo, "repo");
    assert.equal(parseRepositoryUrl("http://github.com/octo/repo"), null);
    assert.equal(parseRepositoryUrl("https://github.com.evil.test/octo/repo"), null);
  });

  await test("repository aggregate API maps minimal fields and proxy links", async () => {
    const calls = [];
    const fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      const url = String(input);
      if (url === "https://api.github.com/repos/octo/repo") {
        return json({ id: 1, full_name: "octo/repo", name: "repo", owner: { login: "octo" }, html_url: "https://github.com/octo/repo", description: "demo", default_branch: "main", language: "JS", stargazers_count: 7, forks_count: 2, updated_at: "2026-01-01T00:00:00Z", secret_field: "must not leak" });
      }
      if (url === "https://api.github.com/repos/octo/repo/releases?per_page=20") {
        return json([{ id: 2, name: "v1", tag_name: "v1", html_url: "https://github.com/octo/repo/releases/tag/v1", published_at: "2026-01-01T00:00:00Z", prerelease: false, assets: [{ id: 3, name: "app.zip", size: 10, download_count: 1, browser_download_url: "https://github.com/octo/repo/releases/download/v1/app.zip", secret: "no" }] }]);
      }
      if (url === "https://api.github.com/repos/octo/repo/contents?ref=main") {
        return json([{ type: "file", name: "README.md", path: "README.md", size: 5, sha: "abc", html_url: "https://github.com/octo/repo/blob/main/README.md", download_url: "https://raw.githubusercontent.com/octo/repo/main/README.md", secret: "no" }]);
      }
      if (url === "https://api.github.com/repos/octo/repo/readme?ref=main") {
        return json({ name: "README.md", path: "README.md", size: 5, sha: "abc", encoding: "base64", html_url: "https://github.com/octo/repo/blob/main/README.md", download_url: "https://raw.githubusercontent.com/octo/repo/main/README.md", content: "very large and intentionally omitted" });
      }
      throw new Error("unexpected API URL " + url);
    };
    const response = await handleRequest(request("/gh/api/repo?url=" + encodeURIComponent("https://github.com/octo/repo")), { CONFIG: { PREFIX: "/gh/" }, GITHUB_TOKEN: "server-secret", fetch });
    assert.equal(response.status, 200);
    const data = await body(response);
    assert.equal(data.repository.full_name, "octo/repo");
    assert.equal(data.releases[0].assets[0].proxy_url, "https://proxy.test/gh/https://github.com/octo/repo/releases/download/v1/app.zip");
    assert.equal(data.contents[0].proxy_url, "https://proxy.test/gh/https://raw.githubusercontent.com/octo/repo/main/README.md");
    assert.equal(data.readme.proxy_url, data.contents[0].proxy_url);
    assert.equal(Object.prototype.hasOwnProperty.call(data.repository, "secret_field"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data.readme, "content"), false);
    assert.ok(calls.every((call) => call.init.headers.get("authorization") === "Bearer server-secret"));
  });

  await test("contents API fixes api.github.com and encodes path/ref", async () => {
    let seen;
    const fetch = async (input, init) => {
      seen = { input: String(input), init };
      return json({ type: "file", name: "x", path: "dir/a b.txt", size: 1, html_url: "https://github.com/o/r/blob/main/dir/a%20b.txt", download_url: "https://raw.githubusercontent.com/o/r/main/dir/a%20b.txt" });
    };
    const response = await handleRequest(request("/gh/api/contents?owner=o&repo=r&path=dir%2Fa%20b.txt&ref=feature%2Fx"), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(response.status, 200);
    const data = await body(response);
    assert.equal(data.contents[0].name, "x");
    assert.equal(seen.input, "https://api.github.com/repos/o/r/contents/dir/a%20b.txt?ref=feature%2Fx");
    assert.equal("https://api.github.com" + buildGithubContentsPath("o", "r", "dir/a b.txt", "feature/x"), seen.input);
    assert.equal(seen.init.body, undefined);
  });

  await test("OPTIONS is complete and terminates before route handling", async () => {
    const response = await handleRequest(request("/gh/anything", { method: "OPTIONS" }), { CONFIG: { PREFIX: "/gh/" }, fetch: () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, POST, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  await test("blob and raw branches convert to jsDelivr", async () => {
    const config = { CONFIG: { PREFIX: "/gh/", jsdelivr: 1 }, fetch: () => { throw new Error("must not fetch"); } };
    const blob = await handleRequest(request("/gh/https://github.com/o/r/blob/main/src/a.js"), config);
    const raw = await handleRequest(request("/gh/https://raw.githubusercontent.com/o/r/main/src/a.js"), config);
    assert.equal(blob.status, 302);
    assert.equal(raw.status, 302);
    assert.equal(blob.headers.get("location"), "https://cdn.jsdelivr.net/gh/o/r@main/src/a.js");
    assert.equal(raw.headers.get("location"), blob.headers.get("location"));
    assert.equal(parseResourceTarget("https://raw.githubusercontent.com/o/r/main/src/a.js").kind, "raw");
  });

  await test("repository home is not a downloadable proxy target", async () => {
    const response = await handleRequest(request("/gh/https://github.com/o/r"), { CONFIG: { PREFIX: "/gh/" }, fetch: () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400);
    assert.equal((await body(response)).error, "repository_url_requires_api");
  });

  await test("invalid target and sensitive headers are handled safely", async () => {
    let seen;
    const fetch = async (input, init) => { seen = { input: String(input), init }; return new Response("ok", { status: 200, headers: { "content-type": "text/plain", "content-security-policy": "default-src 'none'", "clear-site-data": "*" } }); };
    const response = await handleRequest(request("/gh/https://github.com/o/r/raw/main/a.txt", { method: "GET", headers: { Authorization: "client-secret", Cookie: "session", "X-Forwarded-For": "10.0.0.1", Accept: "text/plain" } }), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(response.status, 200);
    assert.equal(seen.init.body, undefined);
    assert.equal(seen.init.headers.get("authorization"), null);
    assert.equal(seen.init.headers.get("cookie"), null);
    assert.equal(seen.init.headers.get("x-forwarded-for"), null);
    assert.equal(seen.init.headers.get("accept"), "text/plain");
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("clear-site-data"), null);
    assert.equal((await response.text()), "ok");
    const invalid = await handleRequest(request("/gh/https://evil.example/o/r/file"), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(invalid.status, 400);
    const normalized = await handleRequest(request("/gh/https:/github.com/o/r/raw/main/a.txt"), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(normalized.status, 200);
  });

  await test("relative, external, and looping redirects", async () => {
    let count = 0;
    const relativeFetch = async (input) => {
      count += 1;
      if (count === 1) return new Response(null, { status: 302, headers: { Location: "/o/r/raw/main/a.txt" } });
      return new Response("done", { status: 200 });
    };
    const relative = await handleRequest(request("/gh/https://github.com/o/r/blob/main/a.txt"), { CONFIG: { PREFIX: "/gh/" }, fetch: relativeFetch });
    assert.equal(relative.status, 200);
    assert.equal(await relative.text(), "done");
    const external = await handleRequest(request("/gh/https://github.com/o/r/raw/main/a.txt"), { CONFIG: { PREFIX: "/gh/" }, fetch: async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/file" } }) });
    assert.equal(external.status, 502);
    assert.equal((await body(external)).error, "unsafe_redirect");
    const looping = await handleRequest(request("/gh/https://github.com/o/r/raw/main/a.txt"), { CONFIG: { PREFIX: "/gh/" }, fetch: async (input) => new Response(null, { status: 302, headers: { Location: String(input) } }) });
    assert.equal(looping.status, 502);
    assert.equal((await body(looping)).error, "redirect_loop");
  });

  await test("git smart HTTP GET and POST are selectively proxied", async () => {
    const calls = [];
    const fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(init.method === "POST" ? "post-ok" : "refs-ok", { status: 200 });
    };
    const info = await handleRequest(request("/gh/https://github.com/o/r.git/info/refs?service=git-upload-pack"), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(info.status, 200);
    assert.equal(calls[0].input, "https://github.com/o/r.git/info/refs?service=git-upload-pack");
    const postRequest = request("/gh/https://github.com/o/r.git/git-upload-pack", { method: "POST", body: "git-payload", headers: { "Content-Type": "application/x-git-upload-pack-request" } });
    const post = await handleRequest(postRequest, { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(post.status, 200);
    assert.equal(calls[1].init.method, "POST");
    assert.equal(new TextDecoder().decode(calls[1].init.body), "git-payload");
    const tags = parseResourceTarget("https://github.com/o/r/tags");
    assert.equal(tags.kind, "tags");
    assert.equal(parseResourceTarget("https://github.com/o/r/tarball/main").kind, "archive");
    assert.equal(parseResourceTarget("https://github.com/o/r/zipball/main").kind, "archive");
    const ordinaryPost = await handleRequest(request("/gh/https://github.com/o/r/raw/main/a.txt", { method: "POST", body: "no" }), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(ordinaryPost.status, 405);
  });

  await test("HEAD has no request or response body", async () => {
    let seen;
    const fetch = async (input, init) => { seen = init; return new Response("not returned", { status: 200 }); };
    const response = await handleRequest(request("/gh/https://raw.githubusercontent.com/o/r/main/a.txt", { method: "HEAD" }), { CONFIG: { PREFIX: "/gh/" }, fetch });
    assert.equal(seen.body, undefined);
    assert.equal(await response.text(), "");
  });
})();
