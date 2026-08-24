/**
 * The Paperline storefront.
 *
 * Plain modules, no framework, no build step. Its only job is to make five API
 * calls in a clear order while somebody records the screen, so every line here
 * is either a request or the smallest amount of UI needed to trigger one.
 */

/**
 * Where the API lives.
 *
 * WireQuill's proxy by default, because that is what the demo is demonstrating.
 * `?api=direct` talks to the backend instead, which is useful when WireQuill is
 * not running — and is also a neat way to show that nothing about the store
 * depends on WireQuill.
 */
const API = resolveApiBase();

function resolveApiBase() {
  const requested = new URL(window.location.href).searchParams.get('api');

  if (requested === null || requested === 'proxy') {
    return 'http://127.0.0.1:3000';
  }
  if (requested === 'direct') {
    return 'http://127.0.0.1:8080';
  }
  return requested.replace(/\/+$/, '');
}

const state = { token: null, cart: 0, product: null };

const el = (id) => document.getElementById(id);
const views = ['login', 'products', 'product', 'cart', 'done'];

function show(name) {
  for (const view of views) {
    el(`view-${view}`).hidden = view !== name;
  }
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;

  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  if (state.token !== null) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });

  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

// ------------------------------------------------------------------- 1. login

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  el('login-error').hidden = true;

  const result = await call('/auth/login', {
    method: 'POST',
    body: { email: el('email').value, password: el('password').value },
  });

  if (!result.ok) {
    el('login-error').textContent = 'Those credentials did not work.';
    el('login-error').hidden = false;
    return;
  }

  state.token = result.payload.access_token;
  el('who').textContent = result.payload.user.email;

  await loadProducts();
});

// ---------------------------------------------------------------- 2. products

async function loadProducts() {
  const result = await call('/products');
  const grid = el('product-grid');

  grid.replaceChildren();

  for (const product of result.payload.items) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';
    card.addEventListener('click', () => void openProduct(product.id));

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = product.name;

    const price = document.createElement('span');
    price.className = 'card-price';
    price.textContent = `${String(product.price)} ${product.currency}`;

    card.append(swatch(product.id), name, price);
    grid.append(card);
  }

  show('products');
}

/** A local placeholder. No remote images anywhere in this demo. */
function swatch(seed) {
  const tones = ['#4ade80', '#7dd3fc', '#fbbf24', '#f472b6'];
  const box = document.createElement('span');

  box.className = 'card-swatch';
  box.style.background = tones[(seed - 1) % tones.length];
  return box;
}

// ---------------------------------------------------------- 3. product detail

async function openProduct(id) {
  const result = await call(`/products/${String(id)}`);
  state.product = result.payload;

  const detail = el('product-detail');
  detail.replaceChildren();

  const title = document.createElement('h1');
  title.textContent = result.payload.name;

  const price = document.createElement('p');
  price.className = 'detail-price';
  price.textContent = `${String(result.payload.price)} ${result.payload.currency}`;

  const description = document.createElement('p');
  description.className = 'muted';
  description.textContent = result.payload.description;

  const add = document.createElement('button');
  add.textContent = 'Add to cart';
  add.addEventListener('click', () => void addToCart(result.payload.id));

  detail.append(title, price, description, add);
  show('product');
}

el('back-to-products').addEventListener('click', () => void loadProducts());

// -------------------------------------------------------------------- 4. cart

async function addToCart(productId) {
  const result = await call('/cart/items', {
    method: 'POST',
    body: { productId, quantity: 1 },
  });

  state.cart = result.payload.itemCount;
  el('cart-count').textContent = `Cart ${String(state.cart)}`;

  const lines = el('cart-lines');
  lines.replaceChildren();

  const line = document.createElement('p');
  line.textContent = `${String(result.payload.itemCount)} item(s) · ${String(result.payload.subtotal)} ${result.payload.currency}`;
  lines.append(line);

  el('checkout-error').hidden = true;
  show('cart');
}

// ---------------------------------------------------------------- 5. checkout

el('checkout-button').addEventListener('click', async () => {
  const result = await call('/checkout', { method: 'POST', body: { paymentMethod: 'invoice' } });

  if (!result.ok) {
    el('checkout-error').textContent = 'Checkout failed.';
    el('checkout-error').hidden = false;
    return;
  }

  el('order-line').textContent =
    `Order ${String(result.payload.orderId)} · ${String(result.payload.total)} ${result.payload.currency}`;

  state.cart = 0;
  el('cart-count').textContent = 'Cart 0';
  show('done');
});

el('start-over').addEventListener('click', () => {
  window.location.reload();
});

// ------------------------------------------------------------------- startup

el('api-mode').textContent = `API ${API}`;
show('login');
