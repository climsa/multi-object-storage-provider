import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

const HASH_VERSION = "v1";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

export class PasswordHasher {
  public async hash(password: string): Promise<string> {
    this.assertPassword(password);
    const salt = randomBytes(SALT_LENGTH);
    const derivedKey = await this.derive(password, salt);

    return [
      "scrypt",
      HASH_VERSION,
      salt.toString("base64url"),
      Buffer.from(derivedKey).toString("base64url"),
    ].join("$");
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    if (!password || !encodedHash) {
      return false;
    }

    const [algorithm, version, encodedSalt, encodedDerivedKey] =
      encodedHash.split("$");

    if (
      algorithm !== "scrypt" ||
      version !== HASH_VERSION ||
      !encodedSalt ||
      !encodedDerivedKey
    ) {
      return false;
    }

    try {
      const salt = Buffer.from(encodedSalt, "base64url");
      const expected = Buffer.from(encodedDerivedKey, "base64url");

      if (salt.byteLength !== SALT_LENGTH || expected.byteLength !== KEY_LENGTH) {
        return false;
      }

      const actual = Buffer.from(await this.derive(password, salt));
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private assertPassword(password: string): void {
    if (password.length < 12 || password.length > 256) {
      throw new Error("Password must contain between 12 and 256 characters");
    }
  }

  private async derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      nodeScrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(Uint8Array.from(key));
      });
    });
  }
}
