// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Pure-JS `@node-rs/argon2` shim.
 *
 * ## Why this exists
 *
 * `@p2p-trust-stack/core` uses `@node-rs/argon2` to derive the AES key that
 * encrypts a VTA's private keys. That package is a **native N-API addon**, and
 * native addons do not load inside the Capacitor embedded Node runtime on
 * Android: the plugin loads Node with `System.loadLibrary("node")` (RTLD_LOCAL),
 * so the addon's `dlopen` cannot resolve the host's `napi_*` symbols —
 *
 *   dlopen failed: cannot locate symbol "napi_get_undefined"
 *
 * Verified on-device against BOTH the Node 18.20.4 and Node 24.18.0 runtimes, so
 * it is a property of the embedding, not of the runtime version.
 *
 * ## Why a shim is safe here
 *
 * The core calls exactly one function, with fixed parameters, from an async
 * context (`core/src/keystore/sqlite-keystore.ts`):
 *
 *   hashRaw(passphrase, { salt, outputLen: 32, algorithm: Algorithm.Argon2id,
 *                         memoryCost: 19456, timeCost: 2, parallelism: 1 })
 *
 * The parameters (Argon2id, 19 MiB, t=2, p=1, 32-byte output) are the OWASP
 * minimum and are *part of the stored format* — they are read back from the
 * keystore row, not assumed. So the derivation stays byte-compatible with the
 * native implementation: same algorithm, same parameters, same output.
 *
 * `@noble/hashes` is already a dependency of the core, so this adds nothing new
 * to the tree. The async variant is used so the KDF does not block the Node
 * thread that also serves the UI bridge.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';

/** Mirrors `@node-rs/argon2`'s `Algorithm` enum (the numeric values matter). */
export const Algorithm = {
  Argon2d: 0,
  Argon2i: 1,
  Argon2id: 2,
};

/**
 * Derive raw key material.
 *
 * @param {string | Uint8Array} password
 * @param {{ salt: Uint8Array, outputLen?: number, algorithm?: number,
 *           memoryCost?: number, timeCost?: number, parallelism?: number }} options
 * @returns {Promise<Uint8Array>}
 */
export async function hashRaw(password, options = {}) {
  const {
    salt,
    outputLen = 32,
    algorithm = Algorithm.Argon2id,
    memoryCost = 19456,
    timeCost = 2,
    parallelism = 1,
  } = options;

  if (algorithm !== Algorithm.Argon2id) {
    throw new Error(
      `@node-rs/argon2 shim: only Argon2id is implemented (received algorithm=${algorithm}).`,
    );
  }
  if (!(salt instanceof Uint8Array) || salt.length === 0) {
    throw new Error('@node-rs/argon2 shim: `salt` must be a non-empty Uint8Array.');
  }

  return argon2idAsync(password, salt, {
    m: memoryCost, // both APIs express the memory cost in KiB
    t: timeCost,
    p: parallelism,
    dkLen: outputLen,
  });
}
