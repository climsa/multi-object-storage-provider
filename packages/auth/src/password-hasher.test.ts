import { describe, expect, it } from "vitest";

import { PasswordHasher } from "./password-hasher.js";

describe("PasswordHasher", () => {
  it("hashes and verifies passwords without storing the password", async () => {
    const hasher = new PasswordHasher();
    const password = "correct horse battery staple";
    const encodedHash = await hasher.hash(password);

    expect(encodedHash).not.toContain(password);
    await expect(hasher.verify(password, encodedHash)).resolves.toBe(true);
    await expect(hasher.verify("wrong password", encodedHash)).resolves.toBe(
      false,
    );
  });

  it("rejects malformed hashes", async () => {
    const hasher = new PasswordHasher();

    await expect(hasher.verify("a valid password", "not-a-hash")).resolves.toBe(
      false,
    );
  });
});

