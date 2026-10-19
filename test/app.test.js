// API smoke tests. They run without MongoDB, Firebase or Stripe credentials,
// so they work the same on a laptop and in GitHub Actions.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../index");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("GET / responds with the server banner", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "Parcel Server is running");
});

test("GET /health reports status", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.ok(["connected", "disconnected"].includes(body.database));
});

test("protected routes reject requests without a token (401)", async () => {
  const routes = [
    ["GET", "/parcels"],
    ["GET", "/payments?email=a@b.com"],
    ["GET", "/riders"],
    ["GET", "/parcels/rider-completed?email=a@b.com"],
    ["POST", "/parcels"],
    ["POST", "/create-checkout-session"],
  ];

  for (const [method, path] of routes) {
    const res = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path} should return 401`);
  }
});

test("protected routes reject an invalid token (403)", async () => {
  const res = await fetch(`${baseUrl}/parcels`, {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.equal(res.status, 403);
});

test("POST /users validates that an email is present", async () => {
  const res = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No Email" }),
  });
  assert.equal(res.status, 400);
});

test("GET /tracking requires a trackingId query param", async () => {
  const res = await fetch(`${baseUrl}/tracking`);
  assert.equal(res.status, 400);
});
