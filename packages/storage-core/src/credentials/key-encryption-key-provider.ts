export interface WrappedDataKey {
  encryptedDataKey: Uint8Array;
  keyVersion: string;
}

export interface KeyEncryptionKeyProvider {
  wrapKey(dataKey: Uint8Array): Promise<WrappedDataKey>;
  unwrapKey(encryptedDataKey: Uint8Array, keyVersion: string): Promise<Uint8Array>;
}

