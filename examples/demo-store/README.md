# Paperline — the WireQuill demo store

A small fictional storefront with a small JSON API, used to demonstrate
WireQuill. It exists so that a recording of WireQuill has something ordinary to
watch, and for no other reason.

No dependencies, no build step, no database. Everything is in memory, so
restarting the process is a complete reset.

## Start it

```powershell
pnpm demo
```

That runs two servers in one process:

```text
Store   http://127.0.0.1:5173
API     http://127.0.0.1:8080
```

Then, in another terminal:

```powershell
npx wirequill --target http://localhost:8080
```

Open the store at `http://127.0.0.1:5173` and the documentation at
`http://127.0.0.1:3001`.

The storefront sends its API requests to `http://127.0.0.1:3000` — WireQuill's
proxy — by default. That is the whole trick: WireQuill sees the traffic because
the traffic goes through it.

## Run without WireQuill

```text
http://127.0.0.1:5173/?api=direct
```

The store then talks to the backend on port 8080 and behaves identically.
Nothing in this example is WireQuill-aware.

## The flow

Five clicks, five endpoints, in this order:

| Step           | Request                     |
| -------------- | --------------------------- |
| Sign in        | `POST /auth/login`          |
| Products list  | `GET /products`             |
| Open a product | `GET /products/{productId}` |
| Add to cart    | `POST /cart/items`          |
| Checkout       | `POST /checkout`            |

Two of those are worth watching in the documentation:

- `POST /auth/login` — WireQuill stores the example as
  `{"email": "[REDACTED]", "password": "[REDACTED]"}`, and the response's
  `access_token` the same way.
- `GET /products/1` and `GET /products/2` become one operation,
  `GET /products/{productId}`.

## Credentials

```text
demo@example.com
demo-password
```

Fake, and deliberately so — they are there to be redacted.

## Reset

```powershell
pnpm demo:reset
```

Clears the store's cart and session, and clears the documentation WireQuill has
accumulated for this demo, so the next run starts at `0 endpoints discovered`.

WireQuill's workspace lives at the project root, which is the repository root —
so the demo shares a database file with anything else here. The reset therefore
never deletes that file. It removes exactly one workspace row: the one whose
project root and target match this demo, and nothing else in it.

Run it **before** starting WireQuill. Rows WireQuill currently has open are not
a helper script's to take away.

## Ports

| Port | What                                 |
| ---- | ------------------------------------ |
| 5173 | Storefront, and the reset endpoint   |
| 8080 | The API WireQuill is pointed at      |
| 3000 | WireQuill proxy (started separately) |
| 3001 | WireQuill documentation              |

Override the demo's own two with `DEMO_APP_PORT` and `DEMO_API_PORT` if
something else is already listening.
