// PixelVault "Upload Screenshots" GitHub Action.
//
// Zero external dependencies — runs on the runner's Node (uses the global fetch
// and Buffer). Globs screenshots, uploads them into one PixelVault collection
// (a CI run) via POST /v1/images/batch, and optionally posts/updates a sticky
// PR comment with the results.

import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";

const MAX_BATCH = 50; // server cap on images per /v1/images/batch request

function input(name, def = "") {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return v === undefined || v === "" ? def : v;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

function notice(msg) {
  console.log(`::notice::${msg}`);
}
function warn(msg) {
  console.log(`::warning::${msg}`);
}
function fail(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}

/** Compile a filename glob (`*`, `?`) to an anchored regex. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Recursively collect file paths under `dir`. Returns [] if `dir` is missing. */
function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function readEvent() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function upsertPrComment({ owner, repo, prNumber, token, body }) {
  const api = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "pixelvault-upload-screenshots",
    "Content-Type": "application/json",
  };
  const MARKER = "<!-- pixelvault-upload-screenshots -->";
  try {
    const listRes = await fetch(
      `${api}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers }
    );
    const comments = listRes.ok ? await listRes.json() : [];
    const existing = Array.isArray(comments)
      ? comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER))
      : null;

    const payload = JSON.stringify({ body });
    const res = existing
      ? await fetch(`${api}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          headers,
          body: payload,
        })
      : await fetch(`${api}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          method: "POST",
          headers,
          body: payload,
        });
    if (!res.ok) warn(`Could not post PR comment (${res.status}).`);
    else notice(`${existing ? "Updated" : "Posted"} PR comment.`);
  } catch (err) {
    warn(`PR comment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function renderComment({ uploaded, failed, collectionId }) {
  const MARKER = "<!-- pixelvault-upload-screenshots -->";
  const rows = uploaded
    .map((it) => {
      const url = it.branded_url || it.url;
      return `| \`${it.filename}\` | [![${it.filename}](${url})](${url}) |`;
    })
    .join("\n");
  const failLine = failed.length
    ? `\n\n<sub>⚠️ ${failed.length} failed: ${failed
        .map((f) => `\`${f.filename}\` (${f.error})`)
        .join(", ")}</sub>`
    : "";
  return [
    MARKER,
    "### 📸 PixelVault screenshots",
    "",
    "| Screenshot | Preview |",
    "| --- | --- |",
    rows,
    "",
    `<sub>${uploaded.length} uploaded · collection \`${collectionId}\`</sub>${failLine}`,
  ].join("\n");
}

async function main() {
  const apiKey = input("api-key");
  if (!apiKey) fail("`api-key` is required.");

  const root = input("path", "test-results");
  const pattern = input("pattern", "*.png");
  const type = input("collection-type", "ci_build");
  const name = input("collection-name") || `gh-${process.env.GITHUB_RUN_ID || "run"}`;
  const visibility = input("visibility", "private");
  const expiresIn = input("expires-in");
  const signExpiresIn = input("sign-expires-in");
  const prComment = input("pr-comment", "true") === "true";
  const apiUrl = input("api-url", "https://api.pixelvault.dev").replace(/\/+$/, "");
  const token = process.env.GITHUB_TOKEN;

  const re = globToRegExp(pattern);
  const files = walk(root).filter((f) => re.test(basename(f)));
  if (files.length === 0) {
    notice(`No files matched ${root} / ${pattern} — nothing to upload.`);
    setOutput("collection-id", "");
    setOutput("count", "0");
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  const event = readEvent();
  const prNumber = event?.pull_request?.number ?? null;

  const metadata = {
    commit: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    repo: process.env.GITHUB_REPOSITORY,
    run_id: process.env.GITHUB_RUN_ID,
    workflow: process.env.GITHUB_WORKFLOW,
    actor: process.env.GITHUB_ACTOR,
    ...(prNumber ? { pr_number: prNumber } : {}),
  };

  const collection = { type, name, visibility, metadata };
  if (expiresIn) collection.expires_in = Number(expiresIn);
  if (signExpiresIn) collection.sign_expires_in = Number(signExpiresIn);

  let collectionId = "";
  const uploaded = [];
  const failed = [];

  for (const group of chunk(files, MAX_BATCH)) {
    const images = group.map((f) => ({
      data: readFileSync(f).toString("base64"),
      filename: basename(f),
      metadata: { path: f },
    }));

    let res;
    try {
      res = await fetch(`${apiUrl}/v1/images/batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ collection, images }),
      });
    } catch (err) {
      fail(`Batch request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      fail(`Batch upload failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const body = await res.json();
    collectionId = body?.data?.collection_id || collectionId;
    for (const item of body?.data?.items ?? []) {
      if (item.ok) uploaded.push(item);
      else failed.push(item);
    }
  }

  setOutput("collection-id", collectionId);
  setOutput("count", String(uploaded.length));
  notice(
    `Uploaded ${uploaded.length} screenshot(s)${
      failed.length ? `, ${failed.length} failed` : ""
    } → collection ${collectionId}`
  );

  if (uploaded.length === 0) fail("No screenshots were uploaded (all items failed).");

  if (prComment && prNumber && token) {
    await upsertPrComment({
      owner,
      repo,
      prNumber,
      token,
      body: renderComment({ uploaded, failed, collectionId }),
    });
  } else if (prComment && !prNumber) {
    notice("No pull request in context — skipping PR comment.");
  }
}

main().catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));
