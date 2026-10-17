// Generate audit keys once (ARCHITECTURE §12). Prints .env lines.
// Usage: bun run scripts/keys.ts >> .env     (then keep them in your secrets store)
import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log(`AUDIT_HMAC_KEY=${randomBytes(32).toString("hex")}`);
console.log(`AUDIT_SIGNING_KEY=${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`);
console.log(`AUDIT_PUBLIC_KEY=${publicKey.export({ format: "der", type: "spki" }).toString("base64")}`);
